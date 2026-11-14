import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  startTurn,
  finishTurn,
  extractClaims,
  indexTurn,
  recentMessages,
  renderAboutThem,
  renderFindings,
} from '../src/memory.ts';
import { findPast, namedDays, recallPast, terms } from '../src/recall.ts';

const FRI = new Date('2026-11-13T10:00:00Z');

function turn(
  db: ReturnType<typeof openDb>,
  t: { q: string; a: string; at: string; chat?: string; summary?: string }
) {
  const r = startTurn(db, { conversationId: t.chat, question: t.q, tz: 'UTC', askedAt: t.at });
  finishTurn(db, r.turnId, t.a, [
    { n: 1, url: 'https://example.com/a', title: 'A', fetched_at: t.at },
  ]);
  if (t.summary) {
    db.prepare('UPDATE turns SET summary = ? WHERE id = ?').run(t.summary, r.turnId);
    indexTurn(db, r.turnId);
  }
  return r;
}

async function file(db: ReturnType<typeof openDb>, turnId: number, record: object) {
  await extractClaims(db, turnId, async () => record, new Map());
}

test('terms drops filler, pointing-back words, dates and short numbers', () => {
  assert.deepEqual(
    terms("what about the 5 laptops you suggested monday? is the ProArt's price still right"),
    ['laptops', 'proart', 'price']
  );
});

test('namedDays resolves weekdays to their last occurrence, and dates to the last one up to today', () => {
  const d = (m: string) => [...(namedDays(m, FRI, 'UTC') ?? [])].sort();
  assert.deepEqual(d('the ones from monday'), ['2026-11-09']);
  assert.deepEqual(d('what did i say on friday'), ['2026-11-06']);
  assert.deepEqual(d('yesterday'), ['2026-11-12']);
  assert.deepEqual(d('on 3 November'), ['2026-11-03']);
  assert.deepEqual(d('december 24th'), ['2025-12-24']);
  assert.equal(namedDays('how much is cursor pro', FRI, 'UTC'), null);
});

test('a paraphrase finds the past exchange through its summary, and a fresh question only gets a one-liner', async () => {
  const db = openDb(':memory:');
  const old = turn(db, {
    q: 'good laptop for video editing under 1.5 lakh',
    a: 'Go with the ASUS ProArt P16 [1]. The MacBook Air M4 and Lenovo Legion 5 are the alternatives.',
    at: '2026-11-09T09:00:00Z',
  });
  await file(db, old.turnId, {
    topic: 'video editing laptops',
    entities: ['ASUS ProArt P16', 'MacBook Air M4', 'Lenovo Legion 5'],
    summary:
      'Suggested ASUS ProArt P16, MacBook Air M4, Lenovo Legion 5 for editing; picked the ProArt',
    claims: [],
    user_facts: [],
  });
  turn(db, { q: 'weather in pune', a: 'Sunny, 31C.', at: '2026-11-12T09:00:00Z' });
  const now = startTurn(db, { question: 'x', tz: 'UTC', askedAt: FRI.toISOString() });

  const fresh = recallPast(db, {
    message: 'is the proart any good for gaming',
    conversationId: now.conversationId,
    now: FRI,
    tz: 'UTC',
    refersBack: false,
  });
  assert.match(fresh, /^# Past chats that share words/);
  assert.match(
    fresh,
    /\[Mon 9 Nov 2026 09:00\] they asked "good laptop for video editing under 1\.5 lakh" -> you: Suggested ASUS ProArt P16/
  );
  assert.doesNotMatch(fresh, /pune/);

  const back = recallPast(db, {
    message: 'any price drops on the laptops you suggested monday?',
    conversationId: now.conversationId,
    now: FRI,
    tz: 'UTC',
    refersBack: true,
  });
  assert.match(back, /^# Log of past questions/);
  assert.match(
    back,
    /"good laptop for video editing under 1\.5 lakh" \(topic: video editing laptops[^\n]*-> you: Suggested/
  );
  assert.match(
    back,
    /## \[Mon 9 Nov 2026 09:00\] they asked: "good laptop[\s\S]*You replied:\nGo with the ASUS ProArt P16\. The MacBook/
  );
  assert.match(back, /Pages behind it: A \(https:\/\/example\.com\/a, read 9 Nov\)/);
});

test('a message that clearly covers one past exchange expands it without any pointing-back phrase', () => {
  const db = openDb(':memory:');
  turn(db, {
    q: 'kindle or kobo for library books',
    a: 'Kobo Clara, because it borrows from OverDrive libraries directly.',
    at: '2026-11-02T09:00:00Z',
    summary: 'Picked Kobo Clara over Kindle for OverDrive library borrowing',
  });
  turn(db, { q: 'kobo stock price', a: 'Rakuten owns Kobo.', at: '2026-11-03T09:00:00Z' });
  const out = recallPast(db, {
    message: 'kobo clara overdrive library borrowing',
    conversationId: 'other',
    now: FRI,
    tz: 'UTC',
    refersBack: false,
  });
  assert.match(
    out,
    /# Past exchanges that best match this message, in full\n## \[Mon 2 Nov 2026 09:00\] they asked: "kindle or kobo/
  );
});

test('a follow-up is findable by its chat subject, and a named day lifts the turns from that day', () => {
  const db = openDb(':memory:');
  const first = turn(db, {
    q: 'kindle or kobo for library books',
    a: 'Kobo Clara.',
    at: '2026-11-09T09:00:00Z',
  });
  const follow = turn(db, {
    q: 'and the cheaper one?',
    a: 'The base model at $109.',
    at: '2026-11-09T09:05:00Z',
    chat: first.conversationId,
  });
  turn(db, { q: 'kindle scribe review', a: 'Good for notes.', at: '2026-11-12T09:00:00Z' });

  const { hits } = findPast(db, 'kindle', { conversationId: 'x', now: FRI, tz: 'UTC' });
  assert.ok(hits.some((h) => h.id === follow.turnId));

  const monday = findPast(db, 'kindle on monday', { conversationId: 'x', now: FRI, tz: 'UTC' });
  assert.ok(monday.hits[0].inWindow);
  assert.notEqual(monday.hits[0].question, 'kindle scribe review');
});

test('a later reading supersedes a claim from the same site, and a newer user fact replaces the old one', async () => {
  const db = openDb(':memory:');
  const pricing = 'https://neon.com/pricing';
  const record = (value: string, facts: object[]) => ({
    topic: 'Neon pricing',
    entities: ['Neon'],
    summary: `Neon Launch is ${value} for a 3 person team`,
    claims: [{ entity: 'Neon', fact: 'Launch price', value, source_url: pricing }],
    user_facts: facts,
  });
  const a = startTurn(db, {
    question: 'neon price for our 3 person team? i live in pune',
    tz: 'UTC',
    askedAt: '2026-11-02T09:00:00Z',
  });
  finishTurn(db, a.turnId, 'Neon Launch is $19/month [1].', [
    { n: 1, url: pricing, title: 'Neon', fetched_at: '2026-11-02T09:00:00Z' },
  ]);
  await extractClaims(
    db,
    a.turnId,
    async () => record('$19/month', [{ subject: 'location', fact: 'Lives in Pune' }]),
    new Map([[pricing, 'Launch $19/month']])
  );

  const b = startTurn(db, {
    question: 'neon price now? moved to berlin btw',
    tz: 'UTC',
    askedAt: '2026-11-12T09:00:00Z',
  });
  finishTurn(db, b.turnId, 'Neon Launch is $25/month [1].', [
    { n: 1, url: pricing, title: 'Neon', fetched_at: '2026-11-12T09:00:00Z' },
  ]);
  await extractClaims(
    db,
    b.turnId,
    async () =>
      record('$25/month', [
        { subject: 'Location', fact: 'Lives in Berlin' },
        { subject: 'mood', fact: 'Feels great' },
      ]),
    new Map([[pricing, 'Launch $25/month']])
  );

  assert.match(
    renderFindings(db, 'UTC', 12_000, [a.turnId]),
    /\$19\/month \(as of 2 Nov, https:\/\/neon\.com\/pricing; read again on 12 Nov: \$25\/month\)/
  );
  assert.equal(renderAboutThem(db, 'UTC'), '- Lives in Berlin (said 12 Nov)');
  const summary = db.prepare('SELECT summary FROM turns WHERE id = ?').get(a.turnId) as {
    summary: string | null;
  };
  assert.equal(summary.summary, 'Neon Launch is $19/month for a 3 person team');
  const rows = db.prepare('SELECT count(*) AS n FROM claims').get() as { n: number };
  assert.equal(rows.n, 2);
});

test('older replies in this chat come back as their summaries, the newest one whole', () => {
  const db = openDb(':memory:');
  const a = turn(db, {
    q: 'q1',
    a: `long ${'x'.repeat(400)}`,
    at: '2026-11-10T08:00:00Z',
    summary: 'Listed A, B and C; picked B',
  });
  turn(db, { q: 'q2', a: 'newest whole', at: '2026-11-10T08:01:00Z', chat: a.conversationId });
  const msgs = recentMessages(db, a.conversationId);
  assert.equal(msgs[1].content, '[Summary of this reply] Listed A, B and C; picked B');
  assert.match(msgs[3].content, /^newest whole/);
});
