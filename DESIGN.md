# Design

MeowGle has one job: answer questions from the live web, and remember what you asked, what it told you, and when. Everything here is judged against three things. Fast, right, good to talk to.

## The shape

```
browser ──SSE── server.ts ── agent.ts ──spawn── claude -p
                    ▲                              │
                    └──── MCP over HTTP ◄──────────┘
                          (web_search → Exa)
```

The model is the Claude Code CLI running headless, on a Claude subscription token or an Anthropic API key, whichever the person running it has. It owns the tool loop. I own the tools.

Each turn starts one `claude -p` process with every built-in tool switched off (`--tools ""`) and an MCP config that points back at my own server, at `/mcp/<random uuid>`. When the model calls `web_search`, the request lands in my process, I run it against Exa, and I push a progress event into the same queue the model's output stream feeds. So the UI sees "searching", "reading 3 pages" and the answer text as one ordered stream.

Why the CLI and not an SDK: one code path that runs on a flat subscription or an API key, a single pinned dependency that is the model runtime itself (`npm install` brings the binary, so there's nothing to install globally), and a tool loop that's already written and battle tested. The cost is a process per turn, a few hidden flags, and some Windows plumbing. I'll take that.

The CLI runs locked down. Isolated config dir, every inherited `CLAUDE*` and `ANTHROPIC*` env var dropped, an empty temp folder as the working directory so no CLAUDE.md gets picked up, and the MCP route only exists while a run is in flight.

## Search

One tool, `web_search`, taking `queries`, `urls`, or both. Everything in one call runs in parallel, so the model can search for what it's missing and read the pages it already knows about in a single round trip.

- Queries hit Exa's `lite` mode. I measured it at 0.8 to 1s per call against 1.6 to 2.4s for `auto`, and it's cheaper. It only searches cached content, which is fine, because search is for finding the right page, not for trusting the number on it.
- URLs are where freshness comes from. If a URL was ever cited before, the harness forces a live crawl. Otherwise it accepts a copy at most a day old. `focus` pulls just the passages about one detail out of a long page.

It used to be two tools, `web_search` and `open_page`. The brief says one tool, and merging them also saved a round trip whenever the model needed both.

Exa sometimes serves a cached copy even when you ask for a live one. So every page goes back to the model tagged with what actually happened (`live`, `cached copy`, or `FAILED`), read off Exa's status field rather than assumed. The model has to say when a number came from a cached copy.

Effort sets the tool budget: 3, 6 or 12 calls. The budget and today's date ride along in every tool result, so the model always knows how much runway it has left.

## Memory

All in SQLite through `node:sqlite`. Memory is not a tool. Code decides what each message carries, so the model keeps its one tool and never spends a round trip remembering.

**Writing.** After each turn a background `claude -p` call files it with a JSON schema: a one-line summary of what MeowGle told them, naming every option it listed and its pick; labels; up to six checkable values ("Neon Launch plan, $19/month, neon.com/pricing, read 10 Nov"); and anything they said about themselves. Code decides what's kept. A value must appear in the answer and in the text of a page the turn actually read. A summary can't carry a number nobody said. A label has to occur in the exchange. A fact about them has to come from their own words. Fetch dates come from the source record, never the model. Rows are never edited: a newer reading of the same value from the same site, or a newer fact on the same subject, just points the old row at the new one, so "$19 on the 2nd, $25 now" stays answerable.

**Reading, per message:**
- This chat: older replies as their one-line summaries, the latest one whole with the pages behind it.
- About them: what they've told MeowGle about themselves, latest per subject.
- Past chats: the message's words are matched against every past exchange with SQLite FTS5. The index covers the question, the reply, the summary, the labels, and the chat around it, so "and the cheaper one?" is findable by its chat's subject. BM25 rank is fused with recency by reciprocal rank, and a named day ("Monday", "3 November") counts as a third list, so it lifts that day's turns without hiding the rest. Usually this yields at most three dated one-liners, enough to recognize "the ones you suggested" without nudging the model to bring them up.
- When the message points back (a phrase like "you said", a named day the best match falls on, or one past exchange that clearly covers its words), the closest exchanges come in full: the reply, its pages with the day each was read, the values saved from it, the turns around it, plus the log of every question with summaries for the last 30 days.

Before this, the model saw only past questions and a few numbers, never its own answers, so "the tools we shortlisted Monday" was unanswerable. The cost is about 300 to 550 extra tokens on an ordinary turn.

Rejected: memory tools (break the one-tool brief and add a round trip); attaching the full log every turn (the model mined it for small talk, which feels like being watched); embeddings (a dependency or an API call per message, and for one person's history, dates and good summaries matter more than similarity); letting an LLM merge memories Mem0-style (lossy, and I want the old value on record).

## Time

Models are bad at date arithmetic. So every message opens with the user's local time and the last 14 days written out with weekdays: "Thu 12 Nov (today), Wed 11 Nov (yesterday), Tue 10 Nov...". "Last Tuesday" becomes a lookup, not a calculation. Everything is stored in UTC with the IANA timezone from the browser, and rendered in that timezone.

## The prompt

One prompt, written as prose in the voice the replies should have. Earlier versions were stacks of rules with word counts and format bans, and every answer came out the same size and shape. The next version explained each habit in prose and got analyst briefings: dense multi-sentence bullets and bull case, bear case, my take. Now the prompt describes who MeowGle is talking to and carries short example exchanges (small talk, a buy question, a news question, a price lookup with a pushback and a follow-up). Length is handled by reasoning, not a cap: the prompt asks the model to pick the three or four things worth repeating and keep the rest for follow-ups, and explains why one-fact list items and sparse bold read faster. The examples set voice and shape: plain text for quick facts, and for multi-part answers a lead-in line and short list items that each open with a bold point. Hard rules are kept to what the app needs to work: tools, citation format, dates, memory.

## Streaming and cleanup

The server speaks SSE. Text the model streams before a tool call is narration ("let me look that up"), so when a tool call starts, I retract it from the answer and re-show it as thinking. Citations get normalized to `[n]` and any number that doesn't match a source from this turn is removed. If the browser hangs up, the CLI process gets killed.

## Tradeoffs and what's next

- A process per turn adds startup latency an SDK call wouldn't have.
- FTS is lexical. A paraphrase that shares no words with the old exchange only lands through its summary and labels. With another week I'd add a small local embedding model as a third ranked list in the same fusion.
- The log of every question still rides along on pointing-back turns. Past a few thousand questions it should be cut to the matched days.
- Live crawls can take around 7s, and some sites fail every time. The model sees the failure and has to find the figure another way.
- A seed script with backdated turns, so the memory features can be tried on day one.
