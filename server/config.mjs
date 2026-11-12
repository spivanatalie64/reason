// Configuration for Reason.
//
// Everything here is overridable from the environment or from
// ~/.config/reason/config.json. The file is optional — the defaults are
// chosen to work on this machine with no setup at all.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();

const configPath =
  process.env.REASON_CONFIG || path.join(home, '.config', 'reason', 'config.json');

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

const file = readConfigFile();

function list(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.length) return value.split(':').filter(Boolean);
  return fallback;
}

export const config = {
  // Roots scanned for Git repositories. ':' separated in env vars.
  roots: list(process.env.REASON_ROOTS || file.roots, [path.join(home, '.ai', '.src')]),

  host: process.env.REASON_HOST || file.host || '127.0.0.1',
  port: Number(process.env.REASON_PORT || file.port || 4321),

  // The opencode session database. Read-only; we never write to it.
  opencodeDb:
    process.env.REASON_OPENCODE_DB ||
    file.opencodeDb ||
    path.join(home, '.local', 'share', 'opencode', 'opencode.db'),

  // Local model for the AI panel. Everything stays on this machine.
  ollama: {
    host: process.env.OLLAMA_HOST || file.ollama?.host || 'http://127.0.0.1:11434',
    model: process.env.REASON_MODEL || file.ollama?.model || 'qwen2.5-coder:7b',
    timeoutMs: Number(file.ollama?.timeoutMs || 180000),
  },

  // AI backends. 'auto' prefers the local Ollama model and falls back to the
  // opencode service that is already running on this machine.
  ai: {
    backend: process.env.REASON_AI_BACKEND || file.ai?.backend || 'auto',
    // Model for the opencode backend: { id, provider }. When unset, the
    // panel uses the model the most recent agent session on this machine
    // used, which is guaranteed to be a working combination.
    model: file.ai?.model || null,
    timeoutMs: Number(file.ai?.timeoutMs || 180000),
  },

  // The opencode service. The host is discovered from the CLI unless it is
  // given explicitly, because the port is not fixed.
  opencodeHost: process.env.REASON_OPENCODE_HOST || file.opencodeHost || null,
  opencodeServicePasswordFile:
    process.env.REASON_OPENCODE_PASSWORD_FILE ||
    file.opencodeServicePasswordFile ||
    path.join(home, '.config', 'opencode', 'service.json'),

  // Branch names treated as "the base" when comparing a topic branch.
  baseBranches: file.baseBranches || ['main', 'master', 'develop', 'trunk'],

  // How often the poller checks for changes and pushes them over SSE.
  pollMs: Number(file.pollMs || 4000),

  // Maximum commits fetched for a graph in one request.
  maxCommits: Number(file.maxCommits || 400),

  // Directories never descended into while discovering repositories.
  skipDirs: new Set(
    (file.skipDirs || ['node_modules', '.venv', 'venv', 'target', 'dist', 'build', '.git']).map(
      (d) => d.toLowerCase(),
    ),
  ),
};

export default config;
