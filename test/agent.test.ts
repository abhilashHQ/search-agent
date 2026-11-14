import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { runTurn, cleanAnswer, type AgentEvent } from '../src/agent.ts';
import { SYSTEM_PROMPT, refersToPast } from '../src/prompt.ts';
import { openDb, startTurn, finishTurn } from '../src/memory.ts';
import type { Message, Model } from '../src/llm.ts';
import type { Book, Tools } from '../src/tools.ts';

test('cleanAnswer: gpt-oss markers become [n], unknown and repeated ones go, odd unicode is normalized', () => {
  const raw = 'A 【3†L1-L2】​ b [2†source] c [9]. d [2][2]【2†x】 e %, non‑breaking';
  assert.equal(cleanAnswer(raw, new Set([2, 3])), 'A [3] b [2] c. d [2] e %, non-breaking');
  assert.equal(
    cleanAnswer('Views 19M [previous ledger]. See [Sources](https://x.y).', new Set()),
    'Views 19M. See [Sources](https://x.y).'
  );
});

test('cleanAnswer: grouped citations split into [n], dropping unknown and repeated ones', () => {
  assert.equal(
    cleanAnswer('A [7, 9]. B [2; 99]. C [3,3].', new Set([2, 3, 7, 9])),
    'A [7][9]. B [2]. C [3].'
  );
});

test('cleanAnswer: dashes become hyphens in ranges and commas elsewhere, literal [n] goes', () => {
  assert.equal(
    cleanAnswer('Takes 3–5 days — or 2 — 4 at most – fast.', new Set()),
    'Takes 3-5 days, or 2-4 at most, fast.'
  );
  assert.equal(
    cleanAnswer('Unwind after it—you earned it [n].', new Set()),
    'Unwind after it, you earned it.'
  );
  assert.equal(
    cleanAnswer('Costs $600–$800 per ton, from Dec 2022–May 2023.', new Set()),
    'Costs $600-$800 per ton, from Dec 2022-May 2023.'
  );
  assert.equal(
    cleanAnswer("It isn't for everyone—pregnant people should skip it.", new Set()),
    "It isn't for everyone, pregnant people should skip it."
  );
});

test('cleanAnswer: unicode bullets become markdown list items', () => {
  assert.equal(
    cleanAnswer('New since Mon:\n• A shipped.\n  ▪ B too.\nThe · stays.', new Set()),
    'New since Mon:\n- A shipped.\n- B too.\nThe · stays.'
  );
});

test('cleanAnswer: narrow and non-breaking spaces inside numbers are fixed, not widened', () => {
  const s = '12 000 sats, $0 /month, 30-70 %, ₹ 1,999, 7.3 % and a b';
  assert.equal(cleanAnswer(s, new Set()), '12,000 sats, $0/month, 30-70%, ₹1,999, 7.3% and a b');
  assert.equal(
    cleanAnswer('Pro $20 / month ( $16 / mo yearly ) and $100 / mo', new Set()),
    'Pro $20/month ($16/mo yearly) and $100/ mo'
  );
});

type Step = { kind: 'thinking' | 'text'; text: string } | { tool: string; args: object };
type Run = { messages: Message[]; effort?: string; toolResults: string[] };

const call = (tool: string, args: object): Step => ({ tool, args });
const text = (t: string): Step => ({ kind: 'text', text: t });

// Plays a script of steps the way the CLI would: text and thinking stream out,
// and each tool step yields a tool event, then calls back into the harness.
function fakeModel(script: Step[], extraction?: object) {
  const runs: Run[] = [];
  const model: Model = {
    async *run(messages, callTool, opts = {}) {
      const run: Run = {
        messages: structuredClone(messages),
        effort: opts.effort,
        toolResults: [],
      };
      runs.push(run);
      for (const step of script) {
        if ('tool' in step) {
          yield { kind: 'tool' };
          run.toolResults.push(await callTool(step.tool, step.args as Record<string, unknown>));
        } else yield step;
      }
    },
    async json() {
      return extraction;
    },
  };
  return { model, runs };
}

const add = (book: Book, url: string, title: string, opened: boolean, text = '') =>
  book.set(url, {
    n: book.size + 1,
    url,
    title,
    fetched_at: '2026-11-12T11:10:00.000Z',
    opened,
    text,
  });

function fakeTools() {
  const seen: { live?: boolean } = {};
  const tools: Tools = {
    async openPage({ urls }, book, live) {
      seen.live = live;
      add(book, urls[0], 'Neon pricing', true, 'Launch $19/month');
      return {
        text: '[1] Neon pricing (neon.com, live)\nLaunch $19/month',
        ok: 1,
        failed: 0,
        domains: [],
      };
    },
    async webSearch(_args, book) {
      add(book, 'https://neon.com/blog/news', 'Neon news', false);
      add(book, 'https://example.com/roundup', 'Roundup', false);
      return {
        text: '[2] Neon news\n...\n\n[3] Roundup\n...',
        ok: 2,
        failed: 0,
        domains: ['neon.com', 'example.com'],
      };
    },
  };
  return { tools, seen };
}

test('runTurn: tool rounds, streamed answer, persistence, live re-open, extraction', async () => {
  const db = openDb(':memory:');
  const past = startTurn(db, {
    question: 'Neon pricing?',
    tz: 'Asia/Kolkata',
    askedAt: '2026-11-10T08:32:00.000Z',
  });
  finishTurn(db, past.turnId, 'Neon Launch is $19/month [1].', [
    {
      n: 1,
      url: 'https://neon.com/pricing',
      title: 'Neon',
      fetched_at: '2026-11-10T08:32:00.000Z',
    },
  ]);
  db.prepare(
    "INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at) VALUES (?, 'Neon', 'Launch price', '$19/month', 'https://neon.com/pricing', '2026-11-10T08:32:00.000Z')"
  ).run(past.turnId);

  const { model, runs } = fakeModel(
    [
      { kind: 'thinking', text: 'Re-open the stored page.' },
      call('web_search', { urls: ['https://neon.com/pricing'], focus: 'Launch price' }),
      call('web_search', { queries: ['Neon pricing change'], since: '2026-11-10' }),
      text('\nStill $19/month 【'),
      text('1†L3-L5】 per Neon [2], nothing new [7].'),
    ],
    {
      topic: 'Neon pricing',
      entities: ['Neon'],
      claims: [
        {
          entity: 'Neon',
          fact: 'Launch price',
          value: '$19/month',
          source_url: 'https://neon.com/pricing',
        },
      ],
    }
  );
  const { tools, seen } = fakeTools();

  const events: AgentEvent[] = [];
  for await (const e of runTurn(
    { db, model, tools, now: () => new Date('2026-11-12T11:10:00Z') },
    { message: 'Is that still right?', tz: 'Asia/Kolkata' }
  ))
    events.push(e);

  assert.deepEqual(
    [...new Set(events.map((e) => e.type))],
    ['start', 'thinking', 'open', 'open_done', 'search', 'search_done', 'answer', 'sources', 'done']
  );
  const answer = events.flatMap((e) => (e.type === 'answer' ? [e.text] : [])).join('');
  assert.equal(answer, 'Still $19/month [1] per Neon [2], nothing new.');
  assert.equal(seen.live, true);
  assert.deepEqual(
    events.find((e) => e.type === 'search'),
    { type: 'search', queries: ['Neon pricing change'], since: '2026-11-10' }
  );
  assert.deepEqual(
    events.find((e) => e.type === 'sources'),
    {
      type: 'sources',
      sources: [
        { n: 1, url: 'https://neon.com/pricing', title: 'Neon pricing' },
        { n: 2, url: 'https://neon.com/blog/news', title: 'Neon news' },
      ],
    }
  );

  assert.equal(runs.length, 1);
  const { messages } = runs[0];
  assert.equal(messages[0].role, 'developer');
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  const tail = messages.at(-1)!.content;
  assert.match(tail, /\] "Neon pricing\?"/);
  assert.doesNotMatch(
    tail.split('# Log of past questions')[1].split('# Past exchanges')[0],
    /\$19/
  );
  assert.match(
    tail,
    /^Now: Thu 12 Nov 2026 16:40 \(Asia\/Kolkata\)\nLast 14 days:\nThu 12 Nov = 2026-11-12 \(today\)/
  );
  assert.match(
    tail,
    /# Past exchanges that best match this message, in full\n## \[Tue 10 Nov 2026 14:02\] they asked: "Neon pricing\?"\nYou replied:\nNeon Launch is \$19\/month\.\nPages behind it: Neon \(https:\/\/neon\.com\/pricing, read 10 Nov\)/
  );
  assert.match(
    tail,
    /Values saved from it:\n- Neon \| Launch price: \$19\/month \(as of 10 Nov, https:\/\/neon\.com\/pricing\)\n\n# Their message\nIs that still right\?\n\n\[Note from the app, not from them\./
  );
  const { toolResults } = runs[0];
  assert.equal(toolResults.length, 2);
  assert.ok(
    toolResults.every((t) => /\n\n\[Today is Thu 12 Nov 2026\. [12] tool calls? left\.\]$/.test(t))
  );
  assert.match(
    toolResults[0],
    /^\[1\] Neon pricing \(neon\.com, live\)[\s\S]*\[Today is Thu 12 Nov 2026\./
  );

  const row = db
    .prepare(
      'SELECT answer, sources, effort, tool_calls, pages_opened, error FROM turns WHERE id = 2'
    )
    .get() as {
    answer: string;
    sources: string;
    effort: string;
    tool_calls: number;
    pages_opened: number;
    error: string | null;
  };
  assert.equal(row.answer, answer);
  assert.deepEqual([row.effort, row.tool_calls, row.pages_opened, row.error], ['low', 2, 1, null]);
  assert.deepEqual(
    JSON.parse(row.sources).map((s: any) => s.url),
    ['https://neon.com/pricing', 'https://neon.com/blog/news']
  );

  await tick();
  await tick();
  const turn = db.prepare('SELECT topic FROM turns WHERE id = 2').get() as { topic: string };
  assert.equal(turn.topic, 'Neon pricing');
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM claims WHERE turn_id = 2').get() as { n: number }).n,
    1
  );
});

test('refersToPast: catches questions about history, ignores small talk and fresh lookups', () => {
  for (const q of [
    'what did i ask you about yesterday?',
    'what did we talk about',
    'have i ever asked about neon?',
    'what were my questions this week',
    'is that price still right?',
    'is that cursor price you gave me still right',
    'remember the laptop thing?',
    'what did you tell me in our last chat',
    'what have i been curious about lately',
    'what was i asking about on tuesday',
  ])
    assert.ok(refersToPast(q), q);
  for (const q of [
    'lol ok cool, long day today honestly',
    'lol ok thanks, that was a lot',
    'hey whats up',
    'how much is cursor pro',
    'kobo or kindle for library books?',
    'anything new from anthropic since monday',
    'is pichai still ceo of google',
    'what happened last week in ai',
    'what did nvidia announce yesterday',
    'how long ago did python 3.12 come out',
    'what changed on 12 nov',
  ])
    assert.ok(!refersToPast(q), q);
});

test('runTurn: a fresh question gets a dated one-liner on a matching past chat, never the log or saved values', async () => {
  const db = openDb(':memory:');
  const past = startTurn(db, {
    question: 'Neon pricing?',
    tz: 'UTC',
    askedAt: '2026-11-10T08:32:00.000Z',
  });
  finishTurn(db, past.turnId, 'Neon Launch is $47/month [1].', []);
  db.prepare(
    "INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at) VALUES (?, 'Neon', 'Launch price', '$47/month', 'https://neon.com/pricing', '2026-11-10T08:32:00.000Z')"
  ).run(past.turnId);
  const { model, runs } = fakeModel([text('Hi.')], {
    topic: 't',
    entities: [],
    claims: [],
  });
  for await (const _ of runTurn(
    { db, model, tools: fakeTools().tools },
    { message: 'what does neon cost', tz: 'UTC' }
  ));
  const tail = runs[0].messages.at(-1)!.content;
  assert.equal(runs[0].messages[0].content, SYSTEM_PROMPT);
  assert.match(
    tail,
    /# Past chats that share words with this message[^\n]*\n\[Tue 10 Nov 2026 08:32\] they asked "Neon pricing\?" -> you: Neon Launch is \$47\/month\.\n\n# Their message/
  );
  assert.doesNotMatch(tail, /# Log of past questions|Values saved/);

  const chat = fakeModel([text('Hey.')], { topic: 't', entities: [], claims: [] });
  for await (const _ of runTurn(
    { db, model: chat.model, tools: fakeTools().tools },
    { message: 'hey whats up', tz: 'UTC' }
  ));
  assert.match(
    chat.runs[0].messages.at(-1)!.content,
    /# Past chats: nothing attached for this message\./
  );
});

test('runTurn: tool calls past the budget are refused and effort reaches the model', async () => {
  const db = openDb(':memory:');
  const { model, runs } = fakeModel(
    [
      ...Array.from({ length: 8 }, () => call('web_search', { queries: ['x'] })),
      text('Best I can tell, x.'),
    ],
    { topic: 't', entities: [], claims: [] }
  );
  const events: AgentEvent[] = [];
  for await (const e of runTurn(
    { db, model, tools: fakeTools().tools },
    { message: 'q', tz: 'UTC', effort: 'medium' }
  ))
    events.push(e);
  assert.equal(runs[0].effort, 'medium');
  assert.equal(events.filter((e) => e.type === 'search').length, 6);
  assert.match(runs[0].toolResults[4], /1 tool call left\./);
  assert.match(runs[0].toolResults[5], /That was your last tool call/);
  assert.match(runs[0].toolResults[6], /^No more lookups this turn/);
  assert.match(runs[0].toolResults[7], /^No more lookups this turn/);
  assert.match(
    runs[0].messages.at(-1)!.content,
    /Effort is medium[\s\S]*You have 6 tool calls at most/
  );
  assert.equal(events.at(-1)?.type, 'done');
});

test('runTurn: one web_search call can search and read pages in parallel, and needs one of them', async () => {
  const db = openDb(':memory:');
  const { model, runs } = fakeModel(
    [
      call('web_search', { queries: ['neon news'], urls: ['https://neon.com/pricing'] }),
      call('web_search', { since: '2026-11-01' }),
      text('Done [1].'),
    ],
    { topic: 't', entities: [], claims: [] }
  );
  const { tools, seen } = fakeTools();
  const events: AgentEvent[] = [];
  for await (const e of runTurn({ db, model, tools }, { message: 'neon?', tz: 'UTC' }))
    events.push(e);
  assert.deepEqual(
    events.map((e) => e.type).filter((t) => /search|open/.test(t)),
    ['search', 'open', 'search_done', 'open_done']
  );
  assert.equal(seen.live, false);
  assert.match(runs[0].toolResults[0], /^# Search results\n[\s\S]*\n\n# Pages\n\[1\] Neon pricing/);
  assert.match(runs[0].toolResults[1], /^Error: pass queries, urls or both/);
});

test('runTurn: narration streamed before a tool call is retracted into thinking, not stored as the answer', async () => {
  const db = openDb(':memory:');
  const { model } = fakeModel(
    [
      text("I'll look up Neon pricing. "),
      call('web_search', { queries: ['neon pricing'] }),
      text('Neon Launch is usage-based [1].'),
    ],
    { topic: 't', entities: [], claims: [] }
  );
  const events: AgentEvent[] = [];
  for await (const e of runTurn(
    { db, model, tools: fakeTools().tools },
    { message: 'neon price?', tz: 'UTC' }
  ))
    events.push(e);
  const types = events.map((e) => e.type);
  const reset = types.indexOf('answer_reset');
  assert.ok(reset > types.indexOf('answer') && reset < types.indexOf('search'));
  assert.deepEqual(events[reset + 1], { type: 'thinking', text: "I'll look up Neon pricing. " });
  const answer = events
    .slice(reset)
    .flatMap((e) => (e.type === 'answer' ? [e.text] : []))
    .join('');
  assert.equal(answer, 'Neon Launch is usage-based [1].');
  assert.equal((db.prepare('SELECT answer FROM turns').get() as { answer: string }).answer, answer);
});

test('runTurn: a dash split across chunks streams the same text that gets stored', async () => {
  const db = openDb(':memory:');
  const { model } = fakeModel([text('Takes 5 –'), text(' 6 days — roughly.')], {
    topic: 't',
    entities: [],
    claims: [],
  });
  const events: AgentEvent[] = [];
  for await (const e of runTurn(
    { db, model, tools: fakeTools().tools },
    { message: 'how long', tz: 'UTC' }
  ))
    events.push(e);
  const streamed = events.flatMap((e) => (e.type === 'answer' ? [e.text] : [])).join('');
  assert.equal(streamed, 'Takes 5-6 days, roughly.');
  assert.equal(
    (db.prepare('SELECT answer FROM turns').get() as { answer: string }).answer,
    streamed
  );
});

test('runTurn: a model failure emits error and keeps the partial answer', async () => {
  const db = openDb(':memory:');
  const model: Model = {
    async *run() {
      yield { kind: 'text', text: 'Partial' };
      throw new Error('The model process failed.');
    },
    async json() {},
  };
  const events: AgentEvent[] = [];
  for await (const e of runTurn(
    { db, model, tools: fakeTools().tools },
    { message: 'q', tz: 'UTC' }
  ))
    events.push(e);
  assert.deepEqual(events.at(-1), { type: 'error', message: 'The model process failed.' });
  assert.equal(
    (db.prepare('SELECT answer FROM turns').get() as { answer: string }).answer,
    'Partial'
  );
});
