import type { DatabaseSync } from 'node:sqlite';
import {
  clip,
  fmtDay,
  fmtStamp,
  localDay,
  renderFindings,
  renderLedger,
  shiftDay,
  shorten,
  stripCitations,
  type Source,
} from './memory.ts';

// Picks what of past chats rides along with a message. No tool and no model
// call: the words of the message are matched against every past exchange
// (question, reply, summary, labels, chat context) with SQLite FTS5, ranked by
// BM25 and fused with recency. Most messages get at most a few one-liners.
// When the message points back at something, the closest exchanges come in
// full, with the log of every question.

// Words that say nothing about the subject: function words, chat filler, and
// the words people use to point back ("you said", "last time"). Dates are
// handled separately, so weekday and month names are dropped too.
const STOP = new Set(
  `a about above after again ago all also am an and any anything are as at be been before being below between
  both best better but by can could did do does doing done down during each else ever few for from further get
  good got had has have having he her here him his how i if in into is it its just know last let like lol many me
  more most much my need no nor not now of off ok okay on once one only or other our out over own please pls
  really same say she should so some something such tell than thanks thank that the their them then there these
  they thing things think this those through time to too under until up us use very want was we were what whats
  when where which while who whom why will with would yeah yes yet yo you your yours hey hi hello earlier remember asked ask said told talked
  discussed mentioned gave suggested recommended chat conversation still right today yesterday week month
  monday tuesday wednesday thursday friday saturday sunday morning tonight
  january february march april may june july august september october november december
  jan feb mar apr jun jul aug sep sept oct nov dec`.split(/\s+/)
);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH =
  '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The subject words of a message, lowercased and deduped. Short numbers go
// too ("the 5 tools" would otherwise match every reply with a 5 in it).
export function terms(message: string): string[] {
  const raw = message.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'+#.-]*/gu) ?? [];
  const cleaned = raw.map((w) => w.replace(/'s$|[.'-]+$/g, ''));
  return [...new Set(cleaned.filter((w) => w.length > 1 && !STOP.has(w) && !/^\d{1,2}$/.test(w)))];
}

// The local days a message names, as YYYY-MM-DD: today, yesterday, this or
// last week, "3 days ago", a weekday (its last occurrence before today), or a
// date like "3 November" (its last occurrence up to today).
export function namedDays(message: string, now: Date, tz: string): Set<string> | null {
  const text = message.toLowerCase();
  const today = localDay(now, tz);
  const days = new Set<string>();
  const back = (from: number, to = from) => {
    for (let i = from; i <= to; i++) days.add(shiftDay(today, -i));
  };

  if (/\b(today|this morning|tonight)\b/.test(text)) back(0);
  if (/\byesterday\b/.test(text)) back(1);
  if (/\bthis week\b/.test(text)) back(0, 6);
  if (/\blast week\b/.test(text)) back(4, 13);
  for (const m of text.matchAll(/\b(\d{1,2}) days? ago\b/g)) back(Number(m[1]));

  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  WEEKDAYS.forEach((name, i) => {
    if (new RegExp(`\\b${name}\\b`).test(text)) back(((dow - i + 6) % 7) + 1);
  });

  const year = Number(today.slice(0, 4));
  const onDate = (day: number, month: string) => {
    const m = MONTHS.indexOf(month.slice(0, 3));
    if (m < 0 || day < 1 || day > 31) return;
    const md = `${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    days.add(`${year}-${md}` <= today ? `${year}-${md}` : `${year - 1}-${md}`);
  };
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH}\\b`, 'g')
  ))
    onDate(Number(m[1]), m[2]);
  for (const m of text.matchAll(new RegExp(`\\b${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g')))
    onDate(Number(m[2]), m[1]);
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) days.add(m[0]);

  return days.size ? days : null;
}

type Row = {
  id: number;
  conversation_id: string;
  asked_at: string;
  question: string;
  answer: string;
  summary: string | null;
  topic: string | null;
  entities: string | null;
  sources: string;
};

type Hit = Row & { inWindow: boolean; lexical: number | null; cover: number; score: number };

// A crude stem, enough to tell whether a past exchange covers a word.
const stem = (w: string) => (w.length > 3 ? w.replace(/(ing|ed|es|s)$/, '') : w);

const RRF_K = 60;

// Past exchanges from other chats that could be what the message is about.
// Candidates are the top BM25 matches, every turn on a day the message names,
// and the six most recent turns. Each gets a reciprocal-rank score from the
// BM25 list and from recency, and a named day counts as if it ranked first in
// a third list, so it lifts a turn without excluding the rest. `cover` is the
// share of the message's subject words the exchange contains.
export function findPast(
  db: DatabaseSync,
  message: string,
  opts: { conversationId: string; now: Date; tz: string }
): { hits: Hit[]; words: string[]; days: Set<string> | null } {
  const words = terms(message);
  const days = namedDays(message, opts.now, opts.tz);

  const lexical = new Map<number, number>();
  if (words.length) {
    const match = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ');
    const rows = db
      .prepare(
        'SELECT rowid AS id FROM turns_fts WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts, 1, 1, 2, 3, 0.5) LIMIT 30'
      )
      .all(match) as { id: number }[];
    rows.forEach((r, i) => lexical.set(r.id, i));
  }

  const ids = new Set(lexical.keys());
  const recent = db
    .prepare("SELECT id FROM turns WHERE answer != '' ORDER BY id DESC LIMIT 6")
    .all() as { id: number }[];
  for (const r of recent) ids.add(r.id);
  if (days) {
    const sorted = [...days].sort();
    const inRange = db
      .prepare("SELECT id FROM turns WHERE answer != '' AND asked_at >= ? AND asked_at < ?")
      .all(`${shiftDay(sorted[0], -1)}T00:00:00Z`, `${shiftDay(sorted.at(-1)!, 2)}T00:00:00Z`) as {
      id: number;
    }[];
    for (const r of inRange) ids.add(r.id);
  }
  if (!ids.size) return { hits: [], words, days };

  const rows = db
    .prepare(
      `SELECT id, conversation_id, asked_at, question, answer, summary, topic, entities, sources FROM turns
       WHERE id IN (${[...ids].join(',')}) AND conversation_id != ? AND answer != '' ORDER BY id DESC`
    )
    .all(opts.conversationId) as Row[];

  const hits = rows.map((r, recency): Hit => {
    const text = [r.question, r.summary, r.topic, r.entities, r.answer].join(' ').toLowerCase();
    const cover = words.length
      ? words.filter((w) => text.includes(stem(w))).length / words.length
      : 0;
    const inWindow = !!days?.has(localDay(new Date(r.asked_at), opts.tz));
    const rank = lexical.get(r.id) ?? null;
    const score =
      (rank === null ? 0 : 1 / (RRF_K + rank)) + 1 / (RRF_K + recency) + (inWindow ? 1 / RRF_K : 0);
    return { ...r, inWindow, lexical: rank, cover, score };
  });
  hits.sort((a, b) => b.score - a.score || b.cover - a.cover);
  return { hits, words, days };
}

const said = (h: { summary: string | null; answer: string }) =>
  h.summary ?? shorten(stripCitations(h.answer).replace(/\s+/g, ' '), 160, '…');

const oneLine = (h: Hit, tz: string) =>
  `[${fmtStamp(new Date(h.asked_at), tz)}] they asked "${clip(h.question, 120)}" -> you: ${said(h)}`;

// One past exchange in full: the chat around it, the reply, the pages behind
// it with the day each was read, and the values saved from it.
function expand(db: DatabaseSync, h: Hit, tz: string): string {
  const near = (op: '<' | '>') =>
    db
      .prepare(
        `SELECT question, answer, summary FROM turns WHERE conversation_id = ? AND id ${op} ? AND answer != ''
         ORDER BY id ${op === '<' ? 'DESC' : 'ASC'} LIMIT 1`
      )
      .get(h.conversation_id, h.id) as
      { question: string; answer: string; summary: string | null } | undefined;
  const before = near('<');
  const after = near('>');
  const pages = (JSON.parse(h.sources) as Source[])
    .map((s) => `${s.title} (${s.url}, read ${fmtDay(new Date(s.fetched_at), tz)})`)
    .join('; ');
  const values = renderFindings(db, tz, 4000, [h.id]).split('\n').slice(1).join('\n');

  return [
    `## [${fmtStamp(new Date(h.asked_at), tz)}] they asked: "${clip(h.question, 300)}"`,
    before
      ? `Just before, in that chat: "${clip(before.question, 160)}" -> you: ${said(before)}`
      : '',
    `You replied:\n${clip(stripCitations(h.answer), 4000)}`,
    pages ? `Pages behind it: ${pages}` : '',
    values ? `Values saved from it:\n${values}` : '',
    after ? `Next in that chat: "${clip(after.question, 160)}" -> you: ${said(after)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// The past-chats block for one message. `refersBack` is the phrase check
// from prompt.ts. Full expansion happens when the message points back, when
// it names a day that the best match falls on, or when one past exchange
// clearly covers its subject (at least 60% of two or more subject words, and
// 20 points ahead of the next).
export function recallPast(
  db: DatabaseSync,
  input: { message: string; conversationId: string; now: Date; tz: string; refersBack: boolean }
): string {
  const { tz, now } = input;
  const { hits, words, days } = findPast(db, input.message, input);
  const [top] = hits;
  const [best, next] = [...hits].sort((a, b) => b.cover - a.cover);
  const clearMatch =
    !!best && words.length >= 2 && best.cover >= 0.6 && best.cover - (next?.cover ?? 0) >= 0.2;
  const full = input.refersBack || (!!days && !!top?.inWindow) || clearMatch;

  if (!full) {
    const related = hits.filter((h) => h.cover >= 0.5).slice(0, 3);
    if (!related.length) return '# Past chats: nothing attached for this message.';
    return (
      `# Past chats that share words with this message. Only for recognizing what they mean if they refer back;` +
      ` don't bring these up otherwise.\n${related.map((h) => oneLine(h, tz)).join('\n')}`
    );
  }

  let picked = hits.filter((h) => h.inWindow).slice(0, 3);
  if (!picked.length && clearMatch) picked = [best];
  if (!picked.length && top) {
    const runnerUp = hits.slice(1).find((h) => h.lexical !== null && h.cover >= 0.5);
    picked = runnerUp ? [top, runnerUp] : [top];
  }
  const log = renderLedger(db, tz, 30_000, now);
  const matched = picked.length
    ? `# Past exchanges that best match this message, in full\n${picked.map((h) => expand(db, h, tz)).join('\n\n')}`
    : '# Past exchanges: nothing in past chats matched this message.';
  return [
    `# Log of past questions (oldest first, times in ${tz}). What was asked and when, with what you said for the last 30 days. Not a source of facts.`,
    log,
    '',
    matched,
  ].join('\n');
}
