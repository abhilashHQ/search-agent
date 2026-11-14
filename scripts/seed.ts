import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTurn } from '../src/agent.ts';
import { handleMcp, type Model } from '../src/llm.ts';
import { fmtStamp, localDay } from '../src/memory.ts';
import type { Effort } from '../src/prompt.ts';
import { namedDays } from '../src/recall.ts';
import { env, setup } from '../src/setup.ts';

// `npm run seed` gives an empty database a past, so the memory features can be
// tried on day one. Nothing is written by hand: each question below goes
// through the real agent, real search and the real memory write path, with
// the clock set back to the day it was "asked". The answers, the pages, the
// summaries, the saved values and the facts about them are whatever the
// agent produces today; only their timestamps are moved into the past.

type Step = { day: string; time: string; chat: string; effort: Effort; message: string };

const SCRIPT: Step[] = [
  {
    day: '3 november',
    time: '11:00',
    chat: 'node',
    effort: 'low',
    message: 'Which Node.js version is the current LTS, and when does it reach end of life?',
  },
  {
    day: 'monday',
    time: '10:30',
    chat: 'crm',
    effort: 'medium',
    message:
      "We're a 20-person sales team and need a CRM. Shortlist 5 options with their per-seat monthly price.",
  },
  {
    day: 'monday',
    time: '10:45',
    chat: 'crm',
    effort: 'low',
    message: 'Which one would you pick for us, and why?',
  },
  {
    day: 'tuesday',
    time: '16:00',
    chat: 'postgres',
    effort: 'medium',
    message:
      'What does Postgres hosting cost on Neon, Supabase and Render for a small production app?',
  },
];

// A wall-clock time on a local day in `tz`, as an instant.
function atLocal(day: string, time: string, tz: string): Date {
  const guess = new Date(`${day}T${time}:00Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(guess)
      .map((x) => [x.type, x.value])
  );
  const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  return new Date(2 * guess.getTime() - shown);
}

const realNow = new Date();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = localDay(realNow, tz);

// Days resolve the same way the agent resolves them when you ask later, so
// "last Tuesday" in a question lands on the seeded Tuesday. A step that would
// fall on today (3 November, run on 3 November) is skipped.
const plan = SCRIPT.map((s) => {
  const [day] = [...namedDays(s.day, realNow, tz)!];
  return { ...s, at: atLocal(day, s.time, tz) };
})
  .filter((s) => localDay(s.at, tz) < today)
  .sort((a, b) => a.at.getTime() - b.at.getTime());

// The CLI reaches the tools over MCP, so the seed serves the MCP route itself
// on a free port, the same way the server does.
const mcp = createServer((req, res) => {
  const m = req.url?.match(/^\/mcp\/([\w-]{36})$/);
  if (!m) return res.writeHead(404).end();
  handleMcp(req, res, m[1]).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  });
});
await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
const { port } = mcp.address() as AddressInfo;

let clock = realNow;
const { db, model, tools } = setup(`http://127.0.0.1:${port}`, () => clock);

const { n: existing } = db.prepare('SELECT count(*) AS n FROM turns').get() as { n: number };
if (existing) {
  console.error(
    `${env('DB_PATH', 'data/meowgle.db')} already has ${existing} turns. The seed only fills an empty` +
      ' database: delete that file, or point DB_PATH at a new one.'
  );
  mcp.close();
  process.exit(1);
}

// runTurn files each turn into memory in the background once it's answered.
// The seed waits for that filing before moving on, so the next question can
// recall what the earlier ones saved.
const filing = new Set<Promise<unknown>>();
const tracked: Model = {
  run: (messages, callTool, opts) => model.run(messages, callTool, opts),
  json(messages, schema) {
    const p = model.json(messages, schema);
    filing.add(p);
    p.catch(() => {}).finally(() => filing.delete(p));
    return p;
  },
};
async function filed() {
  for (;;) {
    await new Promise((r) => setImmediate(r));
    if (!filing.size) return;
    await Promise.allSettled([...filing]);
  }
}

const chats = new Map<string, string>();
let failed = 0;
for (const s of plan) {
  clock = s.at;
  console.log(`\n${fmtStamp(s.at, tz)}  ${s.message}`);
  let turnId = 0;
  let error = '';
  for await (const ev of runTurn(
    { db, model: tracked, tools, now: () => clock },
    { conversationId: chats.get(s.chat), message: s.message, tz, effort: s.effort }
  )) {
    if (ev.type === 'start') {
      chats.set(s.chat, ev.conversationId);
      turnId = ev.turnId;
    }
    if (ev.type === 'error') error = ev.message;
  }
  await filed();

  const t = db
    .prepare(
      `SELECT tool_calls, pages_opened, summary,
        (SELECT count(*) FROM claims WHERE turn_id = turns.id) AS claims,
        (SELECT count(*) FROM user_facts WHERE turn_id = turns.id) AS facts
       FROM turns WHERE id = ?`
    )
    .get(turnId) as {
    tool_calls: number;
    pages_opened: number;
    summary: string | null;
    claims: number;
    facts: number;
  };
  if (error) {
    failed++;
    console.log(`  failed: ${error}`);
    continue;
  }
  console.log(`  ${t.tool_calls} tool calls, ${t.pages_opened} pages read`);
  console.log(`  summary: ${t.summary ?? '(not filed)'}`);
  console.log(`  saved: ${t.claims} values, ${t.facts} facts about them`);
}

mcp.close();
console.log(
  `\nSeeded ${plan.length - failed} of ${plan.length} turns. Run \`npm run dev\` and try:\n` +
    '  On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?\n' +
    '  What did I ask you on 3 November? Is your answer still correct today?\n' +
    '  Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'
);
if (failed) process.exitCode = 1;
