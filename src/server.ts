import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { listConversations, conversationTurns, turnContext } from './memory.ts';
import { handleMcp } from './llm.ts';
import { runTurn } from './agent.ts';
import { env, setup } from './setup.ts';

const port = Number(env('PORT', '3000'));
const { db, model, tools } = setup(`http://127.0.0.1:${port}`);
const indexHtml = new URL('../public/index.html', import.meta.url);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('Body too large');
  }
  return JSON.parse(raw);
}

// POST /api/chat: validates the request, then streams AgentEvents as SSE
// frames. If the client hangs up mid-stream, the loop just stops.
async function chat(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' });
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 8000) {
    return json(res, 400, { error: 'message must be 1-8000 characters' });
  }

  const conversationId =
    typeof body.conversationId === 'string' && /^[\w-]{1,64}$/.test(body.conversationId)
      ? body.conversationId
      : undefined;
  const efforts = ['low', 'medium', 'high'];
  const effort = [body.effort, env('CLAUDE_EFFORT')].find((e) => efforts.includes(e));

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  let closed = false;
  res.on('close', () => (closed = true));

  for await (const event of runTurn(
    { db, model, tools },
    { conversationId, message, tz: body.tz, effort }
  )) {
    if (closed) break;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Routing
//
//   POST /mcp/:runId             -> MCP endpoint for an in-flight model run
//   POST /api/chat               -> chat, SSE stream
//   GET  /api/conversations      -> conversation list
//   GET  /api/conversations/:id  -> turns of one conversation
//   GET  /api/turns/:id/context  -> what went into the model for one turn
//   GET  /                       -> the single-page app
// ---------------------------------------------------------------------------
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    const mcp = url.pathname.match(/^\/mcp\/([\w-]{36})$/);
    if (mcp) return await handleMcp(req, res, mcp[1]);
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      // A JSON content type can't be sent cross-site without a CORS preflight,
      // which this server never answers, so other sites can't spend turns.
      if (!req.headers['content-type']?.startsWith('application/json')) {
        return json(res, 415, { error: 'Send JSON' });
      }
      return await chat(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      return json(res, 200, listConversations(db));
    }
    const match = url.pathname.match(/^\/api\/conversations\/([\w-]{1,64})$/);
    if (req.method === 'GET' && match) {
      return json(res, 200, conversationTurns(db, match[1]));
    }
    const turn = url.pathname.match(/^\/api\/turns\/(\d{1,12})\/context$/);
    if (req.method === 'GET' && turn) {
      const context = turnContext(db, Number(turn[1]));
      return context ? json(res, 200, context) : json(res, 404, { error: 'Not recorded' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(await readFile(indexHtml));
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    else res.end();
  }
}).listen(port, '127.0.0.1', () => console.log(`MeowGle on http://localhost:${port}`));
