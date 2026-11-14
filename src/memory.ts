import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Everything long-term: conversations, turns (question + answer + sources),
// and claims (checkable facts filed per turn by the extractor at the bottom).
export type Source = { n: number; url: string; title: string; fetched_at: string };
export type Claim = { entity: string; fact: string; value: string; source_url: string };
export type Complete = (
  messages: { role: 'system' | 'user'; content: string }[],
  schema: object
) => Promise<any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  title TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  asked_at TEXT NOT NULL,
  tz TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  topic TEXT,
  entities TEXT,
  effort TEXT,
  tool_calls INTEGER,
  pages_opened INTEGER,
  ms INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  entity TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  superseded_by INTEGER
);
CREATE TABLE IF NOT EXISTS user_facts (
  id INTEGER PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  subject TEXT NOT NULL,
  fact TEXT NOT NULL,
  stated_at TEXT NOT NULL,
  superseded_by INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  question, answer, summary, labels, context, tokenize = 'porter unicode61'
);`;

// ---------------------------------------------------------------------------
// Date and timezone formatting
// ---------------------------------------------------------------------------

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // Databases created before these columns existed.
  for (const [table, added] of Object.entries(ADDED_COLUMNS)) {
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    );
    for (const [name, type] of Object.entries(added)) {
      if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  const indexed = db.prepare('SELECT count(*) AS n FROM turns_fts').get() as { n: number };
  if (!indexed.n) {
    const ids = db.prepare("SELECT id FROM turns WHERE answer != ''").all() as { id: number }[];
    for (const { id } of ids) indexTurn(db, id);
  }
  return db;
}

const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  turns: {
    effort: 'TEXT',
    tool_calls: 'INTEGER',
    pages_opened: 'INTEGER',
    ms: 'INTEGER',
    error: 'TEXT',
    summary: 'TEXT',
  },
  claims: { superseded_by: 'INTEGER' },
};

export function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The tz the client sent, or the last one stored, or UTC.
export function resolveTz(db: DatabaseSync, tz: unknown): string {
  if (isValidTz(tz)) return tz;
  const row = db.prepare('SELECT tz FROM turns ORDER BY id DESC LIMIT 1').get() as
    { tz: string } | undefined;
  return row?.tz ?? 'UTC';
}

// Weekday/day/month/year/time for one instant in one zone, computed once and
// reused by all the formatters below.
function parts(date: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    weekday: p.weekday,
    day: p.day,
    month: p.month,
    year: p.year,
    time: `${p.hour}:${p.minute}`,
  };
}

export function fmtStamp(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.time}`;
}

export function fmtDay(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.day} ${p.month}`;
}

export function fmtDate(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

// The local calendar day of an instant, as YYYY-MM-DD.
export function localDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// A YYYY-MM-DD day moved by n days. Noon avoids DST edges.
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

// The block shown at the top of every question: today, yesterday, then the
// 13 days before, each with its ISO date, so the model can resolve "Monday".
export function renderDateStrip(now: Date, tz: string): string {
  const today = localDay(now, tz);
  const days: string[] = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(`${shiftDay(today, -i)}T12:00:00Z`);
    const d = parts(date, 'UTC');
    const label = `${d.weekday} ${d.day} ${d.month} = ${date.toISOString().slice(0, 10)}`;
    days.push(i === 0 ? `${label} (today)` : i === 1 ? `${label} (yesterday)` : label);
  }
  return `Last 14 days:\n${days.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function startTurn(
  db: DatabaseSync,
  t: { conversationId?: string; question: string; tz: string; askedAt: string }
): { conversationId: string; turnId: number } {
  const conversationId = t.conversationId || randomUUID();
  db.prepare('INSERT OR IGNORE INTO conversations (id, created_at, title) VALUES (?, ?, ?)').run(
    conversationId,
    t.askedAt,
    t.question.slice(0, 60)
  );
  const r = db
    .prepare('INSERT INTO turns (conversation_id, asked_at, tz, question) VALUES (?, ?, ?, ?)')
    .run(conversationId, t.askedAt, t.tz, t.question);
  return { conversationId, turnId: Number(r.lastInsertRowid) };
}

export type TurnStats = {
  effort: string;
  toolCalls: number;
  pagesOpened: number;
  ms: number;
  error?: string;
};

export function finishTurn(
  db: DatabaseSync,
  turnId: number,
  answer: string,
  sources: Source[],
  stats?: TurnStats
): void {
  db.prepare(
    `UPDATE turns SET answer = ?, sources = ?, effort = ?, tool_calls = ?, pages_opened = ?, ms = ?, error = ?
     WHERE id = ?`
  ).run(
    answer,
    JSON.stringify(sources),
    stats?.effort ?? null,
    stats?.toolCalls ?? null,
    stats?.pagesOpened ?? null,
    stats?.ms ?? null,
    stats?.error ?? null,
    turnId
  );
  indexTurn(db, turnId);
}

export const stripCitations = (text: string) => text.replace(/\s*\[\d+\]/g, '');

// (Re)writes a turn's row in the full-text index: what was asked, what was
// answered, the one-line summary and labels once the extractor has run, and
// the chat around it (its first question and the question just before), so a
// follow-up like "and the cheaper one?" is findable by its chat's subject.
export function indexTurn(db: DatabaseSync, turnId: number): void {
  const t = db
    .prepare(
      `
    SELECT t.question, t.answer, t.summary, t.topic, t.entities, c.title,
      (SELECT p.question FROM turns p WHERE p.conversation_id = t.conversation_id AND p.id < t.id
       ORDER BY p.id DESC LIMIT 1) AS prev
    FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ?`
    )
    .get(turnId) as
    | {
        question: string;
        answer: string | null;
        summary: string | null;
        topic: string | null;
        entities: string | null;
        title: string | null;
        prev: string | null;
      }
    | undefined;
  db.prepare('DELETE FROM turns_fts WHERE rowid = ?').run(turnId);
  if (!t?.answer) return;
  const labels = [t.topic, ...(JSON.parse(t.entities ?? '[]') as string[])].filter(Boolean);
  db.prepare(
    'INSERT INTO turns_fts (rowid, question, answer, summary, labels, context) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    turnId,
    t.question,
    stripCitations(t.answer),
    t.summary ?? '',
    labels.join(', '),
    [t.title, t.prev].filter(Boolean).join(' / ')
  );
}

type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Cuts an old answer to about `max` chars at a sentence end, so the model
// never sees itself stopping mid-sentence, and marks the cut.
export function shorten(text: string, max = 300, mark = ' [rest of this reply cut]'): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(...['. ', '? ', '! ', '\n'].map((p) => head.lastIndexOf(p)));
  return `${end > max / 3 ? head.slice(0, end + 1).trimEnd() : head.trimEnd()}${mark}`;
}

// This chat so far (the last 30 exchanges), for the model to see as history.
// Citations are stripped (their numbers would clash with this turn's) and
// empty answers are skipped. The newest answer is kept whole and carries the
// pages it cited, so "open the main articles" can go straight to them. Older
// answers shrink to the extractor's one-line summary, which names everything
// the reply listed, or to a sentence-cut excerpt if there is no summary yet.
export function recentMessages(db: DatabaseSync, conversationId: string): ChatMessage[] {
  const rows = db
    .prepare(
      `
    SELECT question, answer, sources, summary FROM turns
    WHERE conversation_id = ? AND answer IS NOT NULL AND answer != ''
    ORDER BY id DESC LIMIT 30`
    )
    .all(conversationId) as {
    question: string;
    answer: string;
    sources: string;
    summary: string | null;
  }[];
  rows.reverse();

  const messages: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const answer = stripCitations(rows[i].answer);
    const isNewest = i === rows.length - 1;
    const summary = rows[i].summary;
    let kept = isNewest ? answer : summary ? `[Summary of this reply] ${summary}` : shorten(answer);
    if (isNewest) {
      const pages = (JSON.parse(rows[i].sources) as Source[]).map((s) => `${s.title} (${s.url})`);
      if (pages.length) kept += `\n\n[Pages behind this reply: ${pages.join('; ')}]`;
    }
    messages.push(
      { role: 'user', content: rows[i].question },
      { role: 'assistant', content: kept }
    );
  }
  return messages;
}

// Every URL the model has ever cited, so reading one again fetches it live.
export function knownUrls(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT sources FROM turns WHERE answer IS NOT NULL').all() as {
    sources: string;
  }[];
  return new Set(rows.flatMap((r) => (JSON.parse(r.sources) as Source[]).map((s) => s.url)));
}

type TurnRow = {
  id: number;
  asked_at: string;
  question: string;
  answer: string | null;
  sources: string;
};

export function listConversations(db: DatabaseSync) {
  return db
    .prepare(
      `
    SELECT c.id, c.title, MAX(t.asked_at) AS updated_at FROM conversations c
    JOIN turns t ON t.conversation_id = c.id GROUP BY c.id ORDER BY updated_at DESC`
    )
    .all();
}

export function conversationTurns(db: DatabaseSync, id: string) {
  const rows = db
    .prepare(
      `
    SELECT id, asked_at, question, answer, sources FROM turns
    WHERE conversation_id = ? ORDER BY id`
    )
    .all(id) as TurnRow[];
  return rows.map((r) => ({ ...r, sources: JSON.parse(r.sources) as Source[] }));
}

// ---------------------------------------------------------------------------
// The ledger and saved findings, rendered into the prompt
// ---------------------------------------------------------------------------

type LedgerRow = {
  asked_at: string;
  question: string;
  topic: string | null;
  entities: string | null;
  summary: string | null;
};

type FindingRow = {
  turn_id: number;
  asked_at: string;
  question: string;
  entity: string;
  fact: string;
  value: string;
  source_url: string;
  fetched_at: string;
  later_value: string | null;
  later_at: string | null;
};

export const clip = (q: string, max = 200) => (q.length > max ? `${q.slice(0, max)}…` : q);

const MONTH_MS = 30 * 24 * 3600 * 1000;

// Every question ever asked, one line each, oldest first. Lines carry the
// topic and entities when present, and for the last 30 days (counted from
// `now`) the one-line summary of the reply. If the whole thing is over budget,
// the oldest lines are trimmed down to question + date only.
export function renderLedger(db: DatabaseSync, tz: string, maxChars = 30_000, now?: Date): string {
  const turns = db
    .prepare(
      'SELECT asked_at, question, topic, entities, summary FROM turns WHERE answer IS NOT NULL ORDER BY id'
    )
    .all() as LedgerRow[];
  if (!turns.length) return 'No past questions yet.';

  const recent = now ? now.getTime() - MONTH_MS : Infinity;
  const full: string[] = [];
  const short: string[] = [];
  for (const t of turns) {
    const head = `[${fmtStamp(new Date(t.asked_at), tz)}] "${clip(t.question)}"`;
    const entities = JSON.parse(t.entities ?? '[]') as string[];
    const aboutWho = entities.length ? `; about: ${entities.join(', ')}` : '';
    const about = t.topic ? ` (topic: ${t.topic}${aboutWho})` : '';
    const said = t.summary && Date.parse(t.asked_at) >= recent ? ` -> you: ${t.summary}` : '';
    full.push(head + about + said);
    short.push(head);
  }

  const lines = [...full];
  let total = lines.reduce((sum, l) => sum + l.length + 1, 0);
  for (let i = 0; i < lines.length && total > maxChars; i++) {
    total -= full[i].length - short[i].length;
    lines[i] = short[i];
  }
  return lines.join('\n');
}

// Claims filed for past questions (all of them, or only those of `turnIds`),
// grouped under the question they came from, newest group first. A claim that
// a later turn read again shows that later value too. Stops once the budget
// is reached.
export function renderFindings(
  db: DatabaseSync,
  tz: string,
  maxChars = 12_000,
  turnIds?: number[]
): string {
  const only = turnIds ? `WHERE c.turn_id IN (${turnIds.map(Number).join(',') || 'NULL'})` : '';
  const rows = db
    .prepare(
      `
    SELECT c.turn_id, t.asked_at, t.question, c.entity, c.fact, c.value, c.source_url, c.fetched_at,
      n.value AS later_value, n.fetched_at AS later_at
    FROM claims c JOIN turns t ON t.id = c.turn_id LEFT JOIN claims n ON n.id = c.superseded_by
    ${only} ORDER BY t.id DESC, c.id`
    )
    .all() as FindingRow[];

  const blocks = new Map<number, string>();
  for (const r of rows) {
    const block =
      blocks.get(r.turn_id) ?? `[${fmtStamp(new Date(r.asked_at), tz)}] "${clip(r.question)}"`;
    const asOf = fmtDay(new Date(r.fetched_at), tz);
    const later =
      r.later_value && r.later_at
        ? `; read again on ${fmtDay(new Date(r.later_at), tz)}: ${r.later_value}`
        : '';
    blocks.set(
      r.turn_id,
      `${block}\n- ${r.entity} | ${r.fact}: ${r.value} (as of ${asOf}, ${r.source_url}${later})`
    );
  }

  const kept: string[] = [];
  let size = 0;
  for (const block of blocks.values()) {
    if (size + block.length > maxChars) break;
    kept.push(block);
    size += block.length + 2;
  }
  return kept.join('\n\n');
}

// What they've said about themselves that is still current, one line each.
export function renderAboutThem(db: DatabaseSync, tz: string): string {
  const rows = db
    .prepare('SELECT fact, stated_at FROM user_facts WHERE superseded_by IS NULL ORDER BY id')
    .all() as { fact: string; stated_at: string }[];
  return rows.map((r) => `- ${r.fact} (said ${fmtDay(new Date(r.stated_at), tz)})`).join('\n');
}

// ---------------------------------------------------------------------------
// Claim validation
// ---------------------------------------------------------------------------

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, ''));
const normUrl = (u: string) => u.replace(/\/+$/, '');

// A value is supported when its numbers appear in the page text (or, for
// non-numeric values, when its meaningful words do).
function supports(value: string, text: string): boolean {
  const nums = numbers(value);
  if (nums.length) {
    const inText = new Set(numbers(text));
    return nums.every((n) => inText.has(n));
  }
  const low = text.toLowerCase();
  return value
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .every((w) => low.includes(w));
}

// Keeps only claims that survive three checks: all fields filled, every number
// in the value also stated in the answer, and the value supported by page text
// (the claim's own page first, then any other source of the turn).
export function validateClaims(
  claims: Claim[],
  answer: string,
  sources: Source[],
  texts: Map<string, string>
): (Claim & { fetched_at: string })[] {
  const inAnswer = new Set(numbers(answer));
  const byUrl = new Map(sources.map((s) => [normUrl(s.url), s]));

  const kept: (Claim & { fetched_at: string })[] = [];
  for (const c of claims) {
    if (!c.entity || !c.fact || !c.value) continue;
    if (!numbers(c.value).every((n) => inAnswer.has(n))) continue;

    const candidates = [byUrl.get(normUrl(String(c.source_url))), ...sources];
    const src = candidates.find((s) => s && supports(c.value, texts.get(s.url) ?? ''));
    if (!src) continue;

    const { entity, fact, value } = c;
    kept.push({ entity, fact, value, source_url: src.url, fetched_at: src.fetched_at });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// The extractor: files a finished turn into long-term memory
// ---------------------------------------------------------------------------

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: '2-5 words, e.g. "Postgres hosting pricing"' },
    entities: {
      type: 'array',
      items: { type: 'string' },
      description: 'Products, companies, people or places the exchange is about',
    },
    summary: {
      type: 'string',
      description:
        'One line, under 200 characters: what the reply told them, naming every option it listed and any pick' +
        ' or verdict, e.g. "Compared Obsidian, Logseq and Notion for offline notes; picked Obsidian"',
    },
    claims: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          entity: { type: 'string' },
          fact: { type: 'string', description: 'What the value is, e.g. "Launch plan price"' },
          value: {
            type: 'string',
            description: 'Bare value exactly as in the answer, e.g. "$19/month"',
          },
          source_url: {
            type: 'string',
            description: 'URL from the source list that supports it',
          },
        },
        required: ['entity', 'fact', 'value', 'source_url'],
      },
    },
    user_facts: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: 'Short stable key, e.g. "location", "job", "team size", "laptop budget"',
          },
          fact: { type: 'string', description: 'In third person, e.g. "Lives in Pune"' },
        },
        required: ['subject', 'fact'],
      },
    },
  },
  required: ['topic', 'entities', 'summary', 'claims', 'user_facts'],
};

const EXTRACT_PROMPT = [
  `You file a research assistant's answers into long-term memory so it can later recall what it told the person` +
    ` and check whether that is still true. Fill in the record for this exchange.`,
  `- summary: one line someone could use months later to recall "the ones you suggested". Name every specific` +
    ` option, product or place the reply listed, and its pick or verdict if it gave one. Small talk gets a few words.`,
  `- claims: up to 6 concrete, checkable facts stated in the answer,` +
    ` such as prices, plan limits, release dates, version numbers, launches.` +
    ` Prefer the ones the user would ask about again.`,
  `- value is the bare value as written in the answer ("$19/month", "10 GB", "v2.3"). No commentary or comparisons.`,
  `- source_url must be copied from the source list.`,
  `- Only facts the sources from this turn state. If the answer repeats facts from earlier in the chat, leave them out.`,
  `- fact names the thing and never contains the value. No relative times like "9 hours ago". No URLs as values.`,
  `- Small talk or answers with no checkable facts get an empty claims list.`,
  `- user_facts: only what the person states about themselves in the question that stays true after this` +
    ` question is answered, such as where they live, what they do, who they live or work with, their devices.` +
    ` What they are asking about, shopping for or want right now is never a user fact; the summary covers that.` +
    ` Not moods, not guesses, nothing from the answer. Usually empty.`,
].join('\n');

type StoredTurn = { question: string; answer: string | null; sources: string; asked_at: string };

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];

// A summary is kept only if every number in it was said in the exchange.
function checkSummary(summary: unknown, exchange: string): string | null {
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const said = new Set(numbers(exchange));
  return numbers(summary).every((n) => said.has(n)) ? clip(summary.trim(), 300) : null;
}

// A user fact is kept only if its numbers and at least one of its words come
// from what they wrote.
function checkUserFacts(facts: unknown, question: string): { subject: string; fact: string }[] {
  if (!Array.isArray(facts)) return [];
  const asked = new Set(numbers(question));
  const said = question.toLowerCase();
  return facts
    .filter((f) => typeof f?.subject === 'string' && typeof f?.fact === 'string')
    .filter((f) => numbers(f.fact).every((n) => asked.has(n)))
    .filter((f) => words(f.fact).some((w) => said.includes(w.slice(0, 5))))
    .slice(0, 3);
}

// Points older rows at the row that replaces them. Rows are never edited
// otherwise or deleted, so an old reading stays on record next to the new one.
function supersede(db: DatabaseSync, table: 'claims' | 'user_facts', id: number, older: number[]) {
  const mark = db.prepare(`UPDATE ${table} SET superseded_by = ? WHERE id = ?`);
  for (const o of older) mark.run(id, o);
}

// Asks the LLM to file the turn (topic, names, a one-line summary, checkable
// claims, things they said about themselves), validates each part in code,
// then writes it and re-indexes the turn. Runs in the background after the
// answer is sent; a failure only means this turn is not remembered in detail.
export async function extractClaims(
  db: DatabaseSync,
  turnId: number,
  complete: Complete,
  texts: Map<string, string>
): Promise<void> {
  const turn = db
    .prepare('SELECT question, answer, sources, asked_at FROM turns WHERE id = ?')
    .get(turnId) as StoredTurn | undefined;
  if (!turn?.answer) return;

  const sources = JSON.parse(turn.sources) as Source[];
  const sourceList = sources.map((s) => `[${s.n}] ${s.url} ${s.title}`).join('\n') || '(none)';
  const user = `Question: ${turn.question}\n\nAnswer:\n${turn.answer}\n\nSources:\n${sourceList}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const args = await complete(
        [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: user },
        ],
        MEMORY_SCHEMA
      );
      const wellFormed =
        typeof args.topic === 'string' &&
        Array.isArray(args.entities) &&
        Array.isArray(args.claims);
      if (!wellFormed) throw new Error('bad shape');

      const kept = validateClaims(args.claims.slice(0, 6), turn.answer, sources, texts);
      const mentioned = `${turn.question}\n${turn.answer}`.toLowerCase();
      const entities = args.entities.filter(
        (e: unknown) => typeof e === 'string' && mentioned.includes(e.toLowerCase())
      );

      db.prepare('UPDATE turns SET topic = ?, entities = ?, summary = ? WHERE id = ?').run(
        args.topic,
        JSON.stringify(entities),
        checkSummary(args.summary, `${turn.question}\n${turn.answer}`),
        turnId
      );

      // A claim replaces an older one only for the same thing read off the same site.
      const insertClaim = db.prepare(`
        INSERT INTO claims (turn_id, entity, fact, value, source_url, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const sameClaim = db.prepare(`
        SELECT id, source_url FROM claims
        WHERE superseded_by IS NULL AND id != ? AND lower(entity) = lower(?) AND lower(fact) = lower(?)`);
      for (const c of kept) {
        const r = insertClaim.run(turnId, c.entity, c.fact, c.value, c.source_url, c.fetched_at);
        const id = Number(r.lastInsertRowid);
        const older = sameClaim.all(id, c.entity, c.fact) as { id: number; source_url: string }[];
        const site = domain(c.source_url);
        supersede(
          db,
          'claims',
          id,
          older.filter((o) => domain(o.source_url) === site).map((o) => o.id)
        );
      }

      // A user fact replaces the older one on the same subject.
      const insertFact = db.prepare(
        'INSERT INTO user_facts (turn_id, subject, fact, stated_at) VALUES (?, ?, ?, ?)'
      );
      const sameFact = db.prepare(
        'SELECT id FROM user_facts WHERE superseded_by IS NULL AND id != ? AND lower(subject) = lower(?)'
      );
      for (const f of checkUserFacts(args.user_facts, turn.question)) {
        const id = Number(insertFact.run(turnId, f.subject, f.fact, turn.asked_at).lastInsertRowid);
        const older = sameFact.all(id, f.subject) as { id: number }[];
        supersede(
          db,
          'user_facts',
          id,
          older.map((o) => o.id)
        );
      }

      indexTurn(db, turnId);
      return;
    } catch (e) {
      if (attempt === 1) console.error(`extractClaims(${turnId}) failed:`, (e as Error).message);
    }
  }
}
