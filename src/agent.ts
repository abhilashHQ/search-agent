import type { DatabaseSync } from 'node:sqlite';
import type { CallTool, Message, Model, ModelEvent } from './llm.ts';
import type { Book, Tools } from './tools.ts';
import { EFFORT, buildMessages, refersToPast, toolFooter, type Effort } from './prompt.ts';
import {
  extractClaims,
  finishTurn,
  knownUrls,
  recentMessages,
  renderAboutThem,
  resolveTz,
  startTurn,
  type Source,
} from './memory.ts';
import { recallPast } from './recall.ts';

export type Deps = { db: DatabaseSync; model: Model; tools: Tools; now?: () => Date };

// A turn gets at most EFFORT[effort].toolCalls tool calls. Past that, tools
// answer with a note telling the model to wrap up.
const OUT_OF_TOOLS = 'No more lookups this turn. Answer from what you already have.';

export type AgentEvent =
  | { type: 'start'; conversationId: string; turnId: number }
  | { type: 'thinking'; text: string }
  | { type: 'search'; queries: string[]; since?: string }
  | { type: 'search_done'; results: number; domains: string[] }
  | { type: 'open'; urls: string[]; live: boolean }
  | { type: 'open_done'; ok: number; failed: number }
  | { type: 'answer'; text: string }
  | { type: 'answer_reset' }
  | { type: 'sources'; sources: { n: number; url: string; title: string }[] }
  | { type: 'done'; ms: number }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Answer cleanup
//
// Models emit odd unicode and their own citation syntaxes (gpt-oss did, when
// it was the model; the cleanup stays for any model). cleanAnswer runs on
// every streamed chunk and on the final text. Each step is one pass; the
// order matters, so the steps are grouped and commented rather than chained
// into one expression.
// ---------------------------------------------------------------------------

// "[3, 7]" and "[2; 9]" become "[3][7]" and "[2][9]".
const splitCitationGroup = (_: string, list: string) =>
  list
    .split(/\s*[,;]\s*/)
    .map((n) => `[${n}]`)
    .join('');

export function cleanAnswer(text: string, valid: Set<number>): string {
  let t = text;

  // Unicode quirks: zero-width chars, non-breaking hyphen, bullets, and
  // narrow/non-breaking spaces glued into numbers, currencies and punctuation.
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width chars
  t = t.replace(/\u2011/g, '-'); // non-breaking hyphen
  t = t.replace(/^[ \t]*[\u2022\u25aa\u25e6\u2023][ \t]+/gm, '- '); // bullets -> list items
  t = t.replace(/(\d)[\u00A0\u202F](?=\d{3}(?!\d))/g, '$1,'); // 12 000 -> 12,000
  t = t.replace(/(\d)[\u00A0\u202F](?=[%/])/g, '$1'); // 70 % -> 70%
  t = t.replace(/([$\u20AC\u00A3\u20B9\u00A5])[\u00A0\u202F]/g, '$1'); // $ 5 -> $5
  t = t.replace(/\/[\u00A0\u202F]+/g, '/'); // $ / month -> $/month
  t = t.replace(/\([\u00A0\u202F]+/g, '(');
  t = t.replace(/[\u00A0\u202F]+\)/g, ')');
  t = t.replace(/[\u00A0\u202F]/g, ' '); // any remaining ones -> plain space

  // Unicode dashes: number ranges keep a hyphen, prose dashes become ", ".
  t = t.replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/g, '$1-'); // 5 - 6 -> 5-6
  t = t.replace(/(\S)\u2013(?=\S)/g, '$1-'); // word-word -> word-word
  t = t.replace(/\s*[\u2013\u2014]\s*/g, ', '); // remaining ones -> ", "

  // Citation markers from every shape the model emits -> plain [n].
  t = t.replace(/\s*\[n\]/g, ''); // literal [n] placeholder
  t = t.replace(/【(\d+)(?:†[^】]*)?】/g, '[$1]'); // 【3†L1-L2】
  t = t.replace(/\[(\d+)†[^\]]*\]/g, '[$1]'); // [2†source]
  t = t.replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\](?!\()/g, splitCitationGroup); // [3, 7]

  // Keep only citations that point at sources fetched this turn, deduped.
  t = t.replace(/\s*\[(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : ''));
  t = t.replace(/(\[\d+\])\1+/g, '$1'); // [2][2] -> [2]
  t = t.replace(/\s*\[(?:previous|ledger|sources?)\b[^\]]*\](?!\()/gi, ''); // [previous]

  return t;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// While streaming, a citation marker can be half-arrived ("A ["). cleanAnswer
// would mangle it, so everything from the last unclosed bracket on is held
// back until the bracket closes. A trailing dash is held back the same way so
// "5 - 6" can become "5-6" once the 6 shows up.
function stablePrefix(raw: string): string {
  const open = Math.max(raw.lastIndexOf('['), raw.lastIndexOf('【'));
  const close = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('】'));
  const hasUnclosedBracket = open > close;
  return (hasUnclosedBracket ? raw.slice(0, open) : raw).replace(/[–—]\s*$/, '');
}

const isText = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isText).slice(0, max);
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

// Runs one tool call: yields progress events, returns the text the model gets
// back. Searches and page reads in the same call run in parallel. Every source
// seen lands in `book`, the shared ledger for this turn.
async function* runTool(
  name: string,
  args: Record<string, unknown>,
  deps: Deps,
  book: Book,
  known: Set<string>,
  pageChars: number
): AsyncGenerator<AgentEvent, string> {
  if (name !== 'web_search') return `Error: unknown tool ${name}.`;
  const queries = strings(args.queries, 8);
  const urls = strings(args.urls, 5);
  if (!queries.length && !urls.length)
    return 'Error: pass queries, urls or both, each a non-empty list of strings.';
  const since = isDay(args.since) ? args.since : undefined;
  const focus = typeof args.focus === 'string' && args.focus.trim() ? args.focus : undefined;
  const live = urls.some((u) => known.has(u)); // known URLs get fetched fresh

  if (queries.length) yield { type: 'search', queries, ...(since ? { since } : {}) };
  if (urls.length) yield { type: 'open', urls, live };
  const [found, read] = await Promise.all([
    queries.length ? deps.tools.webSearch({ queries, since }, book) : undefined,
    urls.length ? deps.tools.openPage({ urls, focus }, book, live, pageChars) : undefined,
  ]);
  if (found) yield { type: 'search_done', results: found.ok, domains: found.domains };
  if (read) yield { type: 'open_done', ok: read.ok, failed: read.failed };

  if (found && read) return `# Search results\n${found.text}\n\n# Pages\n${read.text}`;
  return (found ?? read)!.text;
}

// ---------------------------------------------------------------------------
// Event merging
//
// Model output arrives on the CLI's stdout while tool progress comes from MCP
// requests, so both are pushed into one queue that runTurn drains in order.
// ---------------------------------------------------------------------------
type Item = { model: ModelEvent } | { event: AgentEvent };

function queue<T>() {
  const items: T[] = [];
  let wake = () => {};
  let closed = false;
  return {
    push(x: T) {
      items.push(x);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (items.length) yield items.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

// One user question, end to end:
//   1. persist the turn and resolve the timezone
//   2. build the opening messages (system, this chat, what they've told us,
//      matching past chats, the question)
//   3. run the model; it calls our tools over MCP, within the effort's budget
//   4. clean up the answer, persist it with the sources it cited
//   5. file findings into long-term memory in the background
export async function* runTurn(
  deps: Deps,
  req: { conversationId?: string; message: string; tz?: string; effort?: Effort }
): AsyncGenerator<AgentEvent> {
  const started = Date.now();
  const { db, model } = deps;
  const now = deps.now?.() ?? new Date();
  const tz = resolveTz(db, req.tz);
  const effort = req.effort ?? 'low';
  const budget = EFFORT[effort];

  // -- 1. persist the turn before any work starts
  const { conversationId, turnId } = startTurn(db, {
    conversationId: req.conversationId,
    question: req.message,
    tz,
    askedAt: now.toISOString(),
  });
  yield { type: 'start', conversationId, turnId };

  // -- 2. opening context
  const messages: Message[] = buildMessages({
    about: renderAboutThem(db, tz),
    past: recallPast(db, {
      message: req.message,
      conversationId,
      now,
      tz,
      refersBack: refersToPast(req.message),
    }),
    history: recentMessages(db, conversationId),
    now,
    tz,
    question: req.message,
    effort,
  });

  // -- 3. the model run, with tool calls routed back here
  const book: Book = new Map(); // every source seen this turn, numbered
  const known = knownUrls(db);
  const valid = () => new Set([...book.values()].map((s) => s.n));
  const q = queue<Item>();
  const stop = new AbortController();

  let toolCalls = 0;
  let pagesOpened = 0;
  const callTool: CallTool = async (name, args) => {
    if (++toolCalls > budget.toolCalls) return OUT_OF_TOOLS;
    const run = runTool(name, args, deps, book, known, budget.pageChars);
    for (;;) {
      const step = await run.next();
      if (step.done) {
        const left = budget.toolCalls - toolCalls;
        return `${step.value}\n\n${toolFooter(now, tz, left)}`;
      }
      if (step.value.type === 'open_done') pagesOpened += step.value.ok;
      q.push({ event: step.value });
    }
  };

  let failure: string | undefined;
  (async () => {
    for await (const ev of model.run(messages, callTool, {
      effort: budget.cliEffort,
      timeoutMs: budget.timeoutMs,
      signal: stop.signal,
    }))
      q.push({ model: ev });
  })()
    .catch((e) => (failure = (e as Error).message))
    .finally(() => q.close());

  let raw = ''; // model text since the last tool call
  let sent = 0; // how much of it was streamed already
  let answer = '';
  let cited = new Set<number>();
  let drained = false; // stays false if the client hung up before the run ended

  try {
    for await (const item of q.drain()) {
      if ('event' in item) {
        yield item.event;
        continue;
      }
      const ev = item.model;
      if (ev.kind === 'thinking') {
        yield { type: 'thinking', text: ev.text };
      } else if (ev.kind === 'tool') {
        // text before a tool call was narration: retract it into thinking
        if (raw) {
          if (sent) yield { type: 'answer_reset' };
          yield { type: 'thinking', text: raw };
          raw = '';
          sent = 0;
        }
      } else {
        raw += ev.text;
        // stream the cleaned prefix that is safe to show so far
        const shown = cleanAnswer(stablePrefix(raw), valid()).trim();
        if (shown.length > sent) {
          yield { type: 'answer', text: shown.slice(sent) };
          sent = shown.length;
        }
      }
    }
    drained = true;
  } finally {
    stop.abort(); // the client may have hung up mid-stream
    // whatever happened above, persist the final answer, its sources and how the turn went
    answer = cleanAnswer(raw, valid()).trim();
    cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    if (!drained) failure ??= 'The client disconnected.';
    else if (!answer) failure ??= 'The model returned an empty answer.';
    const sources: Source[] = [...book.values()]
      .filter((s) => cited.has(s.n) || s.opened)
      .map(({ n, url, title, fetched_at }) => ({ n, url, title, fetched_at }));
    finishTurn(db, turnId, answer, sources, {
      effort,
      toolCalls,
      pagesOpened,
      ms: Date.now() - started,
      error: failure,
    });
  }

  // -- 4. send what was not streamed yet, list sources, report failures
  if (answer.length > sent) yield { type: 'answer', text: answer.slice(sent) };

  const shown = [...book.values()]
    .filter((s) => cited.has(s.n))
    .map(({ n, url, title }) => ({ n, url, title }));
  if (shown.length) yield { type: 'sources', sources: shown };

  if (failure) {
    yield { type: 'error', message: failure };
    return;
  }

  // -- 5. filing findings happens in the background; the turn is over
  const texts = new Map([...book.values()].map((s) => [s.url, s.text]));
  extractClaims(db, turnId, model.json, texts).catch((e) => console.error('extractClaims:', e));
  yield { type: 'done', ms: Date.now() - started };
}
