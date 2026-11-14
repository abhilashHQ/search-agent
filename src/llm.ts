import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TOOL_SCHEMAS } from './tools.ts';

export type Message =
  | { role: 'system' | 'developer' | 'user'; content: string }
  | { role: 'assistant'; content: string };

export type ModelEvent = { kind: 'thinking' | 'text'; text: string } | { kind: 'tool' };

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

export type Model = {
  run(
    messages: Message[],
    callTool: CallTool,
    opts?: { effort?: string; timeoutMs?: number; signal?: AbortSignal }
  ): AsyncIterable<ModelEvent>;
  json(messages: Message[], schema: object): Promise<any>;
};

// ---------------------------------------------------------------------------
// Prompt shape
//
// `claude -p` takes one system prompt and one user prompt. The developer
// message becomes the system prompt; chat history is replayed inside a tagged
// block above the current message, so it can't be mistaken for the message
// being answered.
// ---------------------------------------------------------------------------
export function flatten(messages: Message[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer');
  const chat = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const current = chat.pop()?.content ?? '';
  const history = chat
    .map((m) => {
      const tag = m.role === 'user' ? 'person' : 'meowgle';
      return `<${tag}>\n${m.content}\n</${tag}>`;
    })
    .join('\n');
  return {
    system: system.map((m) => m.content).join('\n\n'),
    prompt: history ? `<earlier_chat>\n${history}\n</earlier_chat>\n\n${current}` : current,
  };
}

// Maps one line of `--output-format stream-json --include-partial-messages`
// to what the agent loop cares about. The final `result` line ends the run.
export function parseLine(line: string): ModelEvent | { kind: 'result'; error?: string } | null {
  const e = JSON.parse(line);
  if (e.type === 'result') {
    return e.is_error
      ? { kind: 'result', error: String(e.result || e.subtype) }
      : { kind: 'result' };
  }
  if (e.type !== 'stream_event') return null;

  const ev = e.event;
  if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
    return { kind: 'tool' };
  }
  if (ev.type === 'content_block_delta') {
    if (ev.delta.type === 'text_delta') return { kind: 'text', text: ev.delta.text };
    if (ev.delta.type === 'thinking_delta') return { kind: 'thinking', text: ev.delta.thinking };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP endpoint
//
// Claude Code reaches our tools over MCP's streamable HTTP transport. Each run
// registers its tool handler under a random id, and the CLI is pointed at
// /mcp/<id>, so tool calls land back in the turn that started the run.
// Responses are plain JSON, which the transport allows.
// ---------------------------------------------------------------------------
const MCP_TOOLS = TOOL_SCHEMAS.map(({ function: f }) => ({
  name: f.name,
  description: f.description,
  inputSchema: f.parameters,
}));

const runs = new Map<string, CallTool>();

async function mcpResult(msg: any, callTool: CallTool): Promise<unknown> {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'meowgle', version: '3' },
      };
    case 'tools/list':
      return { tools: MCP_TOOLS };
    case 'tools/call': {
      const text = await callTool(msg.params?.name, msg.params?.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    }
    case 'ping':
      return {};
  }
  throw Object.assign(new Error(`Unknown method ${msg.method}`), { code: -32601 });
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, id: string) {
  const callTool = runs.get(id);
  if (!callTool) return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405).end();

  let raw = '';
  for await (const chunk of req) raw += chunk;
  const msg = JSON.parse(raw);
  if (msg.id === undefined) return res.writeHead(202).end(); // a notification

  const reply = (body: object) =>
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
  try {
    reply({ result: await mcpResult(msg, callTool) });
  } catch (e) {
    reply({ error: { code: (e as any).code ?? -32603, message: (e as Error).message } });
  }
}

// ---------------------------------------------------------------------------
// The model: one `claude -p` process per run, on whoever runs the app's
// Claude subscription token or Anthropic API key.
//
// Isolation: a dedicated CLAUDE_CONFIG_DIR, no setting sources, no built-in
// tools, only our MCP server, and an empty working dir outside any project.
// Only the one credential in use is passed down, since the CLI prefers an
// API key over a token whenever both are in its environment.
// ---------------------------------------------------------------------------
export function makeClaude(cfg: {
  bin: string;
  model: string;
  effort: string;
  configDir: string;
  auth: { oauthToken?: string; apiKey?: string };
  mcpBase: string;
  timeoutMs?: number;
}): Model {
  const workdir = join(tmpdir(), 'meowgle');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(cfg.configDir, { recursive: true });

  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k))
  );
  env.CLAUDE_CONFIG_DIR = cfg.configDir;
  if (cfg.auth.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.auth.oauthToken;
  else if (cfg.auth.apiKey) env.ANTHROPIC_API_KEY = cfg.auth.apiKey;

  const base = [
    '-p',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--model',
    cfg.model,
  ];

  // Spawns the CLI with the system prompt in a file and the prompt on stdin
  // (it can carry the whole ledger, which outgrows a Windows command line),
  // yielding stdout lines.
  async function* exec(
    messages: Message[],
    args: string[],
    opts: { effort?: string; timeoutMs?: number; signal?: AbortSignal } = {}
  ): AsyncGenerator<string> {
    const { system, prompt } = flatten(messages);
    const sysFile = join(workdir, `${randomUUID()}.txt`);
    writeFileSync(sysFile, system);

    const effort = ['--effort', opts.effort ?? cfg.effort];
    const p = spawn(cfg.bin, [...base, ...effort, '--system-prompt-file', sysFile, ...args], {
      cwd: workdir,
      env,
      windowsHide: true,
      signal: opts.signal,
    });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? cfg.timeoutMs ?? 120_000);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((r) => p.on('close', r));
    p.on('error', () => {}); // an abort surfaces as a null exit code instead
    p.stdin.end(prompt);

    try {
      for await (const line of createInterface({ input: p.stdout })) if (line.trim()) yield line;
      const code = await exited;
      if (code !== 0) {
        console.error(`claude exited ${code}: ${stderr.slice(0, 500)}`);
        throw new Error(code === null ? 'The model timed out.' : 'The model process failed.');
      }
    } finally {
      clearTimeout(timer);
      if (p.exitCode === null) p.kill();
      rmSync(sysFile, { force: true });
    }
  }

  return {
    async *run(messages, callTool, opts = {}) {
      const id = randomUUID();
      runs.set(id, callTool);
      const mcp = { mcpServers: { meowgle: { type: 'http', url: `${cfg.mcpBase}/mcp/${id}` } } };
      const tools = MCP_TOOLS.map((t) => `mcp__meowgle__${t.name}`);
      try {
        const args = [
          ...['--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
          // -p defaults to display "omitted": thinking blocks arrive with empty text.
          // Hidden flag, verified on 2.1.323.
          ...['--thinking-display', 'summarized'],
          ...['--tools', '', '--allowedTools', ...tools, '--mcp-config', JSON.stringify(mcp)],
        ];
        for await (const line of exec(messages, args, opts)) {
          const ev = parseLine(line);
          if (ev?.kind === 'result') {
            if (ev.error) throw new Error(ev.error);
          } else if (ev) yield ev;
        }
      } finally {
        runs.delete(id);
      }
    },

    async json(messages, schema) {
      const args = [
        '--output-format',
        'json',
        '--tools',
        '',
        '--json-schema',
        JSON.stringify(schema),
      ];
      let out = '';
      for await (const line of exec(messages, args)) out += line;
      const res = JSON.parse(out);
      if (res.is_error || !res.structured_output)
        throw new Error(String(res.result || res.subtype));
      return res.structured_output;
    },
  };
}
