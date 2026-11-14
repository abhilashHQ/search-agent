# MeowGle v3 spec (implementation contract)

A chat agent with one capability, web search, and a dated memory of everything it was asked. It is judged on architecture: answers fast, gets things right, good to talk to. It must run with `npm install` then `npm run dev`. TypeScript on Node.

The author must be able to explain every line in an interview. Small beats clever. If a choice is not in this spec, pick the simplest option and leave a one-line note in the PR.

## Hard constraints

- Node >= 22.13 (`"engines": {"node": ">=22.13"}`).
- **One runtime dependency:** `@anthropic-ai/claude-code`, pinned exactly, because it is the model runtime and its hidden flags are version-specific. Dev deps: `typescript`, `tsx`, `@types/node`, `prettier`. No web framework, agent framework, LLM SDK, ORM or vector DB.
- The model is the Claude Code CLI (`claude -p`), spawned as a child process from `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (its postinstall puts the native binary there on every platform), or from `CLAUDE_BIN`. It runs on whoever runs the app: their Claude subscription token, or their Anthropic API key.
- Env: load with `process.loadEnvFile()` wrapped in try/catch, so a missing `.env` is fine. No `dotenv`.
- Storage: built-in `node:sqlite` (`DatabaseSync`). DB file at `data/meowgle.db`, gitignored, overridable with `DB_PATH`.
- HTTP: `node:http`. Streaming uses SSE. The UI is one static `public/index.html` with inline JS and CSS and no build step.
- Exa is called with `fetch` directly. The model is a child process; our tools reach it over MCP served by our own HTTP server.
- Scripts:
  - `"dev": "tsx src/server.ts"`
  - `"test": "tsx --test test/*.test.ts"`
  - `"typecheck": "tsc --noEmit"`
- tsconfig: strict, `module`/`moduleResolution` `NodeNext`, target ES2022.
- Tests never hit the network. The LLM and search are passed in as functions so tests can swap in fakes.
- No filler comments.

## Env (`.env.example`, all listed)

```
CLAUDE_CODE_OAUTH_TOKEN=     # a Claude subscription token from `npx claude setup-token`
ANTHROPIC_API_KEY=           # or an API key; used only when no token is set
EXA_API_KEY=
CLAUDE_MODEL=claude-opus-5-5
CLAUDE_EFFORT=low            # default when the UI doesn't send one
CLAUDE_CONFIG_DIR=           # defaults to data/claude-config, never the user's ~/.claude
CLAUDE_BIN=                  # optional, a different claude binary
AGENT_API_TOKEN=             # when set, /api/* needs it as a Bearer token
PORT=3000
DB_PATH=data/meowgle.db
```

Only the credential in use is passed to the CLI: in `-p` mode it prefers `ANTHROPIC_API_KEY` over a token whenever both are in its environment.

## File layout

```
src/server.ts    HTTP routes, SSE, static file, request validation, bearer gate, MCP route
src/agent.ts     runTurn(): builds the prompt, runs the model, serves its tool calls, yields events, persists
src/llm.ts       makeClaude(): spawns `claude -p`, parses stream-json; handleMcp(): the MCP endpoint
src/tools.ts     the web_search schema + webSearch() + openPage() against Exa
src/memory.ts    db open/migrate, turn writes, FTS index, renderLedger(), renderDateStrip(), extractClaims()
src/recall.ts    findPast() + recallPast(): which past chats ride along with a message
src/prompt.ts    SYSTEM_PROMPT constant + buildMessages()
public/index.html
test/*.test.ts
```

Eight files plus tests (recall.ts split out of memory.ts, which was already past the limit). If a file passes ~250 lines, stop and ask before splitting it.

## Data model

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  asked_at TEXT NOT NULL,          -- UTC ISO
  tz TEXT NOT NULL,                -- IANA tz from the browser
  question TEXT NOT NULL,          -- verbatim
  answer TEXT,                     -- final text, reasoning stripped, null until done
  sources TEXT NOT NULL DEFAULT '[]', -- JSON [{n,url,title,fetched_at}], written by code
  topic TEXT,                      -- null until extraction lands
  entities TEXT,                   -- JSON string[], null until extraction lands
  summary TEXT,                    -- one line naming what the reply listed and picked
  effort TEXT, tool_calls INTEGER, pages_opened INTEGER, ms INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  entity TEXT NOT NULL,
  fact TEXT NOT NULL,              -- e.g. "Launch plan price"
  value TEXT NOT NULL,             -- e.g. "$19/month"
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,        -- copied from the source record, never from the model
  superseded_by INTEGER            -- a later claim, same entity + fact + site
);
CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  subject TEXT NOT NULL,           -- stable key: "location", "team size"
  fact TEXT NOT NULL,              -- "Lives in Pune"
  stated_at TEXT NOT NULL,
  superseded_by INTEGER            -- a later fact on the same subject
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  question, answer, summary, labels, context, tokenize = 'porter unicode61'
);                                 -- rowid = turns.id; context = chat title + previous question
```

Rows are never edited after they're written, apart from `superseded_by` and the extractor filling `topic`, `entities` and `summary`.

Memory is global across conversations because there is a single user. `conversation_id` only decides which messages are sent verbatim.

## Tools (the one capability: web search)

The model sees one function, `mcp__meowgle__web_search`:

`web_search({ queries?: string[] (1-8), urls?: string[] (1-5), since?: "YYYY-MM-DD", focus?: string })`
- At least one of `queries` / `urls`, or the call returns an error the model can recover from. `since` applies to queries, `focus` to urls.
- Queries and urls in the same call run in parallel (`Promise.all`). With both, the result has a `# Search results` part and a `# Pages` part; source numbers are shared.

Queries:
- One Exa `POST /search` per query, run in parallel, `type: "lite"`, `numResults` 6 for 1-2 queries, 4 for 3-5, 3 beyond, `contents: { highlights: true }`.
  - `lite` measured 0.8-1s per call vs 1.6-2.4s for `auto`, at $4 vs $7 per 1k. It searches cached content only, which is fine because freshness comes from reading the page through `urls`.
- `since` maps to `startPublishedDate` as a full ISO string (`2026-11-10T00:00:00.000Z`). Results carry `publishedDate`.
- Results are deduped by URL across queries.
- Each result gets a source number `n` that is unique within the turn.
- Returned to the model as compact text: `[n] title (domain, published YYYY-MM-DD)\n<highlights>`. Grouped under a `## Query: "..."` line per query; a repeat URL points back to its number.

Urls:
- One Exa `POST /contents` call.
- With `focus`: `highlights: { query: focus, maxCharacters: 2000 }` only. Without it: `text: { maxCharacters: 6000 }` (12000 at high effort), with a cut-off marker when the cap is hit.
- **Freshness rule, enforced by the harness:** if any URL appears in any stored turn's `sources`, send `maxAgeHours: 0`. Otherwise send `maxAgeHours: 24`, so a first-time open never reads a copy older than a day.
- **Provenance comes from `statuses[]`, never assumed.** Exa can silently serve a cached copy even with `maxAgeHours: 0`; in testing this happened for pipedrive.com. Each page goes back to the model tagged with what actually happened:
  - `[n] title (domain, live)` when `status: success, source: crawled`
  - `[n] title (domain, cached copy)` when `source: cached`
  - `[n] FAILED: <url> (<error.tag>)` when `status: error`. Failed pages are missing from `results`; only `statuses` lists them. hubspot.com/pricing failed every time.
- Pages get source numbers the same way as search results.
- A live crawl can take ~7s, so the UI shows "Reading N pages (live)" while it waits.

Timeouts: 10s per Exa call. Retry once on 5xx or a network error. Never throw out of a tool. Return the error text so the model can react.

## Agent loop (`runTurn`)

1. Insert the `turns` row with `question`, `asked_at`, `tz`, and create the conversation if it's new (title = first 60 chars of the first question).
2. Build the messages (see Prompt).
3. Run the model once. Claude Code owns the tool loop; we own the tools.
   - `runTurn` hands the model a `callTool(name, args)` callback. The model registers it under a random run id and starts the CLI with `--mcp-config` pointing at `http://127.0.0.1:PORT/mcp/<id>`.
   - Tool calls arrive as MCP `tools/call` requests, run `web_search` in this process, and push `search` / `open` events into the same queue the model's stdout feeds. `runTurn` drains that queue, so tool progress streams while the CLI waits.
   - Every tool result ends with the tool footer (today's date, the question).
   - Tool budget by effort (`EFFORT` in `prompt.ts`): low 3, medium 6, high 12. The effort brief and budget ride in the user message; each tool footer says how many lookups are left. Further calls get "No more lookups this turn. Answer now…" instead of running.
   - Text streamed before a tool call is narration: emit `answer_reset` if some of it was sent, re-emit it as `thinking`, and drop it from the answer.
   - When the client hangs up, the run is aborted and the CLI killed.
4. Model events come from `--output-format stream-json --verbose --include-partial-messages`:
   - `text_delta` -> answer text, `thinking_delta` -> `thinking`, `content_block_start` of a `tool_use` -> narration retraction.
   - The final `result` line with `is_error` becomes an `error` event.
5. Citations: normalize stray formats to `[n]`, remove any `[n]` that doesn't match a source from this turn. `cleanAnswer` also turns dashes into commas or hyphens.
6. Persist `answer` and `sources`. Only sources actually cited, plus every URL opened, go into `sources`.
7. Emit `done`.
8. Fire `extractClaims(turnId)` without awaiting it.

Process: one `claude -p` per turn, timeout by effort (120s / 150s / 300s). Flags: `--strict-mcp-config --setting-sources "" --no-session-persistence --tools "" --allowedTools mcp__meowgle__web_search --model --effort --thinking-display summarized`. The last one is a hidden flag: `-p` otherwise sends `display: "omitted"`, so thinking blocks stream with empty text and the UI has nothing to show. The `showThinkingSummaries` setting does not help in `-p` mode. Thinking is adaptive, so easy turns and many low-effort turns have none. The system prompt goes in a temp file (`--system-prompt-file`) and the prompt on stdin, since the prompt can carry the whole ledger, which outgrows a Windows command line. Env drops every inherited `CLAUDE*` / `ANTHROPIC*` var and sets `CLAUDE_CONFIG_DIR` plus either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Working dir is an empty folder under the OS temp dir, outside any project, so no CLAUDE.md is picked up. The binary is the native `claude.exe` from the pinned package, spawned without a shell.

`--safe-mode` is not used: it disables MCP servers too, which removes our tools.

## SSE events (`POST /api/chat` -> `text/event-stream`)

Request body: `{ conversationId?: string, message: string, tz: string }`

```ts
type AgentEvent =
  | { type: 'start'; conversationId: string; turnId: number }
  | { type: 'thinking'; text: string }                        // delta
  | { type: 'search'; queries: string[]; since?: string }
  | { type: 'search_done'; results: number; domains: string[] }
  | { type: 'open'; urls: string[]; live: boolean }
  | { type: 'open_done'; ok: number; failed: number }
  | { type: 'answer'; text: string }                          // delta
  | { type: 'answer_reset' }                                  // discard answer text streamed so far
  | { type: 'sources'; sources: { n: number; url: string; title: string }[] }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string };
```

Other routes:
- `GET /api/conversations`: list of conversations.
- `GET /api/conversations/:id`: its turns, so the UI can render history.
- `GET /`: serves the HTML.

## Prompt

`buildMessages()` order:

The instructions go in a `developer` message, which becomes the CLI's system prompt. It stays byte-identical across turns so it hits the prompt cache. When the ledger is attached, it goes in the current user message after the date strip. The CLI takes one user prompt, so chat history is flattened into an `<earlier_chat>` block (`<person>` / `<meowgle>` tags) above the current message. The newest earlier reply carries the titles and URLs it cited.

1. **System prompt** (static constant). Contains:
   - **Voice:** a sharp, warm friend who knows the topic. Lead with the direct answer. Explain what it means for this person in plain prose. Bullets only for real side-by-side comparisons. No headers in short answers, minimal bold, no "Great question". Match the user's length and tone. Chit-chat gets a short reply with no search.
   - **Search policy:** search when the answer depends on facts that change or that you aren't sure of. Scale effort to the question. Put all independent lookups in one `web_search` call. Start broad, then narrow. Prefer primary sources such as vendor pricing pages and official changelogs over SEO roundups. Read the page through `urls`, with `focus`, when excerpts don't contain the exact number. Stop when you can answer.
   - **Citations:** cite as `[n]` right after the claim it supports. Never cite a source you didn't receive. Never state a number that isn't in a source or the ledger.
   - **Time:** dates come from the date strip, never from your own arithmetic. Say the resolved date out loud ("on Tuesday 10 Nov"). Put dates on time-sensitive facts.
   - **Memory rules:** the ledger is everything you've been asked, across all chats.
     - If the user refers to a past question, find it by date and topic.
     - If the date has nothing but a nearby date matches the topic, say so ("I have that on Sunday 8 Nov") and proceed.
     - If nothing matches, say so plainly and never invent what was discussed.
   - **Verification rules:** for "still correct / changed since" questions, open the stored source URLs (the harness forces a live crawl). Use `web_search` with `since` = the original date for news. Give every old claim one verdict: unchanged, changed (old to new, with citation), or couldn't verify (show the old value and its date). Never say unchanged without a page opened this turn. A `cached copy` page counts but must be named as such ("per a cached copy of their pricing page"). A `FAILED` page means search for that entity's pricing instead of giving up.
2. **Current chat:** up to the last 30 exchanges of this conversation. Older replies appear as their one-line summary (or a sentence-cut excerpt if extraction hasn't landed); the newest reply is whole and lists the pages it cited. Tool results are never replayed.
3. **Tail** (last user message), in order:
   - `Now: Thu 12 Nov 2026 16:40 (Asia/Kolkata)` and `renderDateStrip(now, tz)`, the last 14 local days with weekdays.
   - `# About them`: current `user_facts`, one line each with the day it was said. Omitted when empty.
   - The past-chats block from `recallPast()` (recall.ts). Candidates are the top 30 FTS5 BM25 matches on the message's subject words (stopwords, pointing-back words, weekday/month names and 1-2 digit numbers dropped), every turn on a day the message names, and the 6 most recent turns, all from other chats. Score = 1/(60+bm25 rank) + 1/(60+recency rank) + 1/60 if on a named day. `cover` = share of subject words the exchange contains.
     - Default: up to 3 one-liners with cover >= 0.5 (`[date] they asked "..." -> you: <summary>`), headed as being for recognition only. None: `# Past chats: nothing attached for this message.`
     - Full, when `refersToPast()` matches, or a named day holds the top hit, or the best-covered exchange has cover >= 0.6 over 2+ words and leads the next by 0.2: the log of every question (summaries for the last 30 days, oldest lines trimmed past 30k chars), then the picked exchanges in full: the turns on the named day (up to 3), else the clear match, else the top hit plus one lexical runner-up. Each shows the reply, its pages with read dates, its saved values (with any later reading), and the turns before and after it in that chat.
   - `# Their message`, then the effort reminder.

Timezone: everything is stored in UTC and rendered in the request's `tz`. If `tz` is missing or invalid, fall back to the last valid tz stored, then UTC.

## Memory write path (`extractClaims`)

- One `claude -p --output-format json --tools "" --json-schema <schema>` call. The parsed object comes back in `structured_output`.
- Input: the question, the answer, and the turn's source list.
- Schema: `{ topic, entities: string[], summary, claims: { entity, fact, value, source_url }[] (max 6), user_facts: { subject, fact }[] (max 3) }`. The prompt asks for bare values ("$15/month") and a summary that names every option listed and the pick.
- Code keeps:
  - a claim only if every number in `value` appears in `answer` and the value is supported by the text of a page read this turn (its own page first). `fetched_at` comes from the source record.
  - the summary only if every number in it appears in the question or answer.
  - an entity only if it occurs in the question or answer.
  - a user fact only if its numbers and at least one of its words come from the question.
- A new claim with the same entity + fact (case-insensitive) from the same domain as an open older claim sets the older one's `superseded_by`. A user fact does the same by `subject`. Nothing is deleted.
- After writing, `indexTurn()` refreshes the FTS row so the summary and labels are searchable.
- If the call fails or the shape is wrong, retry once. Then leave the turn unfiled and log it.

## UI (`public/index.html`)

- Light mode, clean, one column. A conversation list with a "New chat" button.
- Each turn shows a live activity trail above the answer, updated from events:
  - "Thinking…", which can expand to show the reasoning text
  - "Searching: q1, q2…", then "12 results from neon.com, supabase.com…"
  - "Reading 3 pages (live)"
  - The trail collapses to a one-line summary when the answer starts.
- The answer streams in as markdown. Keep the renderer tiny and inline: paragraphs, lists, bold, links, code.
- `[n]` renders as a small clickable superscript. A sources row under the answer shows favicon, domain and title.
- Sends `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Every `/api` call carries `Authorization: Bearer <token>` from localStorage. On a 401 the page prompts for the token once and retries.

## Tests (`node:test`, no network)

- `renderDateStrip`: weekday labels, and the tz boundary (`2026-11-11T20:00Z` in Asia/Kolkata is local 12 Nov).
- `renderLedger`: a full line, a line with failed extraction, the truncation rule, the empty ledger.
- Claim validation: keeps a grounded claim; drops one with an unknown URL; drops one whose value isn't in the answer.
- Citation normalization: `【3†L1-L2】` becomes `[3]`, and a dangling `[9]` is removed.
- `flatten` (system prompt + transcript) and `parseLine` (stream-json to model events).
- `runTurn` with a fake model that calls back into the harness: tool calls then an answer; events come in the right order; the turn is persisted; a stored URL is opened live; the tool budget; narration retraction; failure keeps the partial answer.

## Verified

Claude Code 2.1.322, 13 Nov 2026:

1. **Our HTTP MCP endpoint works with plain JSON responses.** The CLI probes `server/discover` (we return -32601), then `initialize`, `notifications/initialized`, a `GET` (we return 405), `tools/list`, `tools/call`. Tool use came back in ~10s wall time for one search round.
2. **`--tools ""` removes every built-in tool while MCP tools stay.** Asked to list files and run `whoami`, the model said it had no shell tool.
3. **`--safe-mode` disables MCP servers**, so it can't be used.
4. **`--json-schema` returns `structured_output`** with the parsed object, ~2s.
5. **Exa works** as described in the Tools section (verified 12 Nov).

## Running it for reviewers

Reviewers clone the repo and run it on their own Claude access: `npm install`, copy `.env.example` to `.env`, set `CLAUDE_CODE_OAUTH_TOKEN` (their subscription) or `ANTHROPIC_API_KEY`, plus `EXA_API_KEY`, then `npm run dev`.

There is no hosted demo on the owner's subscription. Anthropic's Claude Code terms don't allow routing other people's requests through Pro/Max credentials. A hosted demo would need an API key with a spend cap, `AGENT_API_TOKEN` as a shared password, and server-side caps on concurrency, daily turns and effort.

## Deferred

- `npm run seed` with backdated demo turns. Reviewers start with an empty DB, so this is needed before submitting.
- DESIGN.md (one page) and README.
