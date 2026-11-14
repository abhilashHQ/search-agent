import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './memory.ts';
import { makeClaude } from './llm.ts';
import { makeExaTools } from './tools.ts';

try {
  process.loadEnvFile();
} catch {}

export const env = (k: string, fallback = '') => process.env[k]?.trim() || fallback;

// The CLI comes from the pinned @anthropic-ai/claude-code dependency, whose
// postinstall puts the native binary at bin/claude.exe on every platform.
// It is spawned directly, without a shell.
const bundledClaude = fileURLToPath(
  new URL('../node_modules/@anthropic-ai/claude-code/bin/claude.exe', import.meta.url)
);

// Everything a turn needs, built from .env. Shared by the server and the seed.
// `mcpBase` is where the CLI reaches our tools; `clock` dates the pages read.
export function setup(mcpBase: string, clock?: () => Date) {
  // Claude access: a Claude subscription token (from `npx claude setup-token`)
  // or an Anthropic API key. The token wins when both are set.
  const oauthToken = env('CLAUDE_CODE_OAUTH_TOKEN');
  const apiKey = oauthToken ? '' : env('ANTHROPIC_API_KEY');
  if (!oauthToken && !apiKey) {
    console.warn(
      'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env, or every answer will fail.'
    );
  }
  if (!env('EXA_API_KEY')) console.warn('Missing EXA_API_KEY in .env, searches will fail.');

  return {
    db: openDb(env('DB_PATH', 'data/meowgle.db')),
    model: makeClaude({
      bin: env('CLAUDE_BIN', bundledClaude),
      model: env('CLAUDE_MODEL', 'claude-opus-5-5'),
      effort: env('CLAUDE_EFFORT', 'low'),
      configDir: resolve(env('CLAUDE_CONFIG_DIR', 'data/claude-config')),
      auth: { oauthToken, apiKey },
      mcpBase,
    }),
    tools: makeExaTools(env('EXA_API_KEY'), clock),
  };
}
