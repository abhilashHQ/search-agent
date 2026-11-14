# Design

MeowGle is a chat agent with one tool, web search, that remembers what you asked, what it answered, and when. I built it against the brief's three goals: answer fast, get it right, be good to talk to.

## How it works

```
browser ──SSE── server.ts ── agent.ts ──spawn── claude -p
                    ▲                              │
                    └──── MCP over HTTP ◄──────────┘
                          (web_search → Exa)
```

**The loop.** Each turn spawns one headless Claude Code process (`claude -p`) with every built-in tool switched off and an MCP config pointing back at my own server (`/mcp/<run id>`). Claude runs the tool loop, I own the one tool. Tool calls land in my process, run against Exa, and push progress into the same queue as the model's output, so the UI shows "searching", "reading 3 pages (live)" and the answer as one ordered stream. Effort sets the budget: 3, 6 or 12 tool calls, and every tool result says how many are left.

**The tool.** `web_search` takes `queries`, `urls`, or both, run in parallel in one call. Queries use Exa's `lite` search to find pages: I measured 0.8 to 1s per call against 1.6 to 2.4s for `auto`. URLs read pages, and that's where freshness comes from. A URL MeowGle has cited before is always crawled live; anything else takes a copy at most a day old. Exa sometimes serves a cached copy even when asked for a live one, so each page goes back tagged `live`, `cached copy` or `FAILED` from Exa's own status field, and the model has to say when a number came from a cached copy.

**Memory.** SQLite through `node:sqlite`. Memory is not a tool: code decides what each message carries.

- *Writing.* After each answer, a background call files the turn against a JSON schema: a one-line summary naming every option the reply listed and its pick, labels, up to six checkable values with their source page, and anything the person said about themselves. Code checks each piece. A value must appear in the answer and on a page the turn actually read. A summary can't carry a number nobody said. A fact about them must come from their own words. Read dates come from the source record, never the model. Rows are never rewritten: a newer reading of the same value from the same site points the old row at the new one, so "$19 on the 2nd, $25 now" stays answerable.
- *Reading.* Every message opens with the local time and the last 14 days written out with weekdays, so "last Tuesday" is a lookup. Then: what they've said about themselves; this chat, with older replies as their summaries and the latest whole with its pages; and past chats, found with SQLite FTS5 over the question, reply, summary, labels and surrounding chat, ranked by BM25 fused with recency, with a named day as a third ranked list. Usually that's at most three dated one-liners. When the message points back ("you said", "on Monday", or one past exchange clearly covers it), the matching exchanges come in full: the reply, its pages with read dates, the saved values, and the log of every question.
- *Checking.* For "is it still right?" the model re-opens the stored pages, live, and gives every old value one verdict: unchanged, changed (old to new, cited), or couldn't verify.

**Cleanup.** Text streamed before a tool call is narration, so it moves into the thinking trail. Citations are normalized to `[n]`, and any citation that doesn't match a source from this turn is dropped.

## Why I built it this way

- **The CLI as the model runtime.** One code path for a Claude subscription or an API key, one pinned dependency that is the runtime itself, and a tool loop that's already battle tested. The price is a process per turn.
- **Memory outside the tool.** The model never spends a round trip remembering, and every turn gets the same deterministic context.
- **Search finds, reading verifies.** A fast cached index is fine for finding the right page. Trusting a number needs the page itself.
- **Dates in code.** Models are bad at date arithmetic, so the calendar is written out for them.
- **Remember answers, not just questions.** My first cross-chat memory carried every past question plus a few saved numbers. The model never saw its own replies from other chats, so "the tools you shortlisted on Monday" got "I don't have enough context". Filing a summary of every reply, and pulling in the full exchange when a message points back, fixed that for about 300 to 550 extra tokens on an ordinary turn.

## What I considered and rejected

- **v1, a fixed pipeline on Gemini.** A fast planner wrote the queries, code ran them, a review decided on another round, then the main model answered. It wrote the plan before seeing any results, it spread across 20 files that I couldn't explain in one sitting, and Gemini rate limits kept failing turns.
- **v2, a single loop on Bedrock's gpt-oss-120b.** The loop stayed and the model went. It had its own citation syntax and odd unicode (the cleanup in `agent.ts` still handles both), and I wanted a Claude model without paying per token through the SDK.
- **Two tools**, `web_search` and `open_page`. The brief says one tool, and merging them saved a round trip whenever the model needed both.
- **Memory as tools.** Breaks the one-tool rule and adds a round trip.
- **The full question log on every turn.** The model mined it for small talk, which feels like being watched.
- **Embeddings.** A dependency or an API call per message. For one person's history, dates and good summaries matter more than similarity.
- **Letting an LLM merge memories**, Mem0-style. Lossy, and I want the old value on record.
- **A prompt made of rules.** Word counts and format bans made every answer the same size and shape. The prompt is now prose in MeowGle's voice with short example exchanges.

## With another week

- **An eval harness** from the brief's example questions plus traps (a day with nothing on it, a price that changed after it was saved), scoring correct answers, invented memories and time to first token.
- **Embeddings as a third ranked list** in the recall fusion, from a small local model, so a paraphrase that shares no words with an old exchange still lands.
- **One warm model process** instead of one per turn, to cut the startup cost.
- **Trim the question log** to the matched days once history passes a few thousand questions.
- **Split `memory.ts`**, which grew past 700 lines.
