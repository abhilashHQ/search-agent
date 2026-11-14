# Design

MeowGle has one job: answer questions from the live web, and remember what you asked and when. Everything here is judged against three things. Fast, right, good to talk to.

## The shape

```
browser ──SSE── server.ts ── agent.ts ──spawn── claude -p
                    ▲                              │
                    └──── MCP over HTTP ◄──────────┘
                          (web_search, open_page → Exa)
```

The model is the Claude Code CLI running headless on a Claude subscription. It owns the tool loop. I own the tools.

Each turn starts one `claude -p` process with every built-in tool switched off (`--tools ""`) and an MCP config that points back at my own server, at `/mcp/<random uuid>`. When the model calls `web_search`, the request lands in my process, I run it against Exa, and I push a progress event into the same queue the model's output stream feeds. So the UI sees "searching", "reading 3 pages" and the answer text as one ordered stream.

Why the CLI and not an SDK: zero runtime dependencies, a frontier model on a flat subscription, and the tool loop is already written and battle tested. The cost is a process per turn, a few hidden flags, and some Windows plumbing. I'll take that.

The CLI runs locked down. Isolated config dir, every inherited `CLAUDE*` and `ANTHROPIC*` env var dropped, an empty temp folder as the working directory so no CLAUDE.md gets picked up, and the MCP route only exists while a run is in flight.

## Search

Two tools, both take lists, so one call fans out in parallel.

- `web_search` hits Exa's `lite` mode. I measured it at 0.8 to 1s per call against 1.6 to 2.4s for `auto`, and it's cheaper. It only searches cached content, which is fine, because search is for finding the right page, not for trusting the number on it.
- `open_page` is where freshness comes from. If a URL was ever cited before, the harness forces a live crawl. Otherwise it accepts a copy at most a day old.

Exa sometimes serves a cached copy even when you ask for a live one. So every page goes back to the model tagged with what actually happened (`live`, `cached copy`, or `FAILED`), read off Exa's status field rather than assumed. The model has to say when a number came from a cached copy.

Effort sets the tool budget: 3, 6 or 12 calls. The budget and today's date ride along in every tool result, so the model always knows how much runway it has left.

## Memory

Two layers, both in SQLite through `node:sqlite`.

The ledger is every question ever asked, across all chats, one line each, with the local timestamp. It's cheap, complete and dated. When it gets past 30k characters the oldest lines shrink to date plus question.

Claims are the specific values the model gave you: "Neon Launch plan, $19/month, from neon.com/pricing, read 10 Nov". After each turn a second `claude -p` call extracts them with a JSON schema, and then code decides what's kept. A claim survives only if every number in it appears in the answer and the value is backed by the text of a page this turn actually read, its own page first. The fetch date is copied from the source record, never from the model. Claims are never edited. A re-check writes new ones.

No vector DB. It's one user. Their whole history fits in the context window, and for "did this change since Monday" the date matters far more than semantic similarity.

The ledger only gets attached when the question points at the past ("you said", "last time", "still correct"). When it was always attached, the model kept bringing up old questions in small talk, which feels like being watched.

## Time

Models are bad at date arithmetic. So every message opens with the user's local time and the last 14 days written out with weekdays: "Thu 12 Nov (today), Wed 11 Nov (yesterday), Tue 10 Nov...". "Last Tuesday" becomes a lookup, not a calculation. Everything is stored in UTC with the IANA timezone from the browser, and rendered in that timezone.

## The prompt

One prompt, written as prose in the voice the replies should have. Earlier versions were stacks of rules with word counts and format bans, and every answer came out the same size and shape. The next version explained each habit in prose and got analyst briefings: dense multi-sentence bullets and bull case, bear case, my take. Now the prompt describes who MeowGle is talking to and carries short example exchanges (small talk, a buy question, a news question, a price lookup with a pushback and a follow-up). Length is handled by reasoning, not a cap: the prompt asks the model to pick the three or four things worth repeating and keep the rest for follow-ups, and explains why one-fact list items and sparse bold read faster. The examples set voice and shape: plain text for quick facts, and for multi-part answers a lead-in line and short list items that each open with a bold point. Hard rules are kept to what the app needs to work: tools, citation format, dates, memory.

## Streaming and cleanup

The server speaks SSE. Text the model streams before a tool call is narration ("let me look that up"), so when a tool call starts, I retract it from the answer and re-show it as thinking. Citations get normalized to `[n]` and any number that doesn't match a source from this turn is removed. If the browser hangs up, the CLI process gets killed.

## Tradeoffs and what's next

- A process per turn adds startup latency an SDK call wouldn't have.
- The ledger grows linearly. Truncation holds for a long while, but past a few thousand questions it needs retrieval in front of it.
- Live crawls can take around 7s, and some sites fail every time. The model sees the failure and has to find the figure another way.
- A seed script with backdated turns, so the memory features can be tried on day one.
