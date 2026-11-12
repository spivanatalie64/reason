// The AI panel.
//
// Two backends, in order of preference:
//
//   1. Ollama — a model running on this machine. Nothing leaves the box.
//   2. The local opencode server — the same agent runtime the rest of this
//      machine's AI work already uses, so the panel reasons with the same
//      models the agents do.
//
// The backend is chosen per request: if the preferred one fails, the other
// one is tried, and the response says which one actually answered. A failed
// backend is marked unhealthy for a while so we do not pay the timeout on
// every single request.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import config from './config.mjs';

const SYSTEM = `You are the analysis engine inside Reason, a local dashboard for reviewing AI agent work on a developer's machine.

Rules:
- Answer only from the material you are given. Do not invent files, commits or steps.
- Be concrete. Name files, functions, commits and branches where the material names them.
- No preamble, no closing summary of your own answer, no corporate padding.
- Plain prose or short bullet points. No markdown headings unless asked for.
- If the material is empty or does not answer the question, say exactly that.`;

/* ------------------------------------------------------------------ */
/* Backend plumbing                                                    */
/* ------------------------------------------------------------------ */

const unhealthy = new Map();
const UNHEALTHY_FOR_MS = 45000;

function markUnhealthy(name) {
  unhealthy.set(name, Date.now() + UNHEALTHY_FOR_MS);
}

function isHealthy(name) {
  const until = unhealthy.get(name);
  if (!until) return true;
  if (Date.now() > until) {
    unhealthy.delete(name);
    return true;
  }
  return false;
}

/* ---------------------------------- ollama ------------------------- */

function ollamaEndpoint(pathname) {
  return `${config.ollama.host.replace(/\/$/, '')}${pathname}`;
}

async function ollamaStatus() {
  try {
    const res = await fetch(ollamaEndpoint('/api/tags'), { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { available: false, reason: `ollama returned ${res.status}` };
    const body = await res.json();
    const models = (body.models || []).map((m) => m.name);
    return {
      available: true,
      host: config.ollama.host,
      models,
      modelPresent: models.includes(config.ollama.model),
      reason: models.includes(config.ollama.model) ? null : `model ${config.ollama.model} is not pulled`,
    };
  } catch (err) {
    return { available: false, reason: `cannot reach ollama at ${config.ollama.host}`, detail: String(err.message || err) };
  }
}

async function ollamaGenerate(prompt, { system = SYSTEM, temperature = 0.2 } = {}) {
  const res = await fetch(ollamaEndpoint('/api/generate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      prompt: system ? `${system}\n\n${prompt}` : prompt,
      stream: false,
      options: { temperature, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(config.ollama.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const body = await res.json();
  return {
    text: (body.response || '').trim(),
    tokens: body.eval_count ?? null,
    durationMs: body.total_duration ? Math.round(body.total_duration / 1e6) : null,
    model: body.model || config.ollama.model,
    backend: 'ollama',
  };
}

/* ---------------------------------- opencode ----------------------- */

/**
 * Find the local opencode service.
 *
 * `opencode service status` prints the URL of the running service, which is
 * how the CLI itself finds it. The port is not fixed, so it is discovered
 * rather than guessed.
 */
let opencodeHostCache = null;
let opencodeHostCheckedAt = 0;

function readServicePassword() {
  const file = config.opencodeServicePasswordFile ||
    path.join(os.homedir(), '.config', 'opencode', 'service.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).password || null;
  } catch {
    return null;
  }
}

async function discoverOpencodeHost() {
  if (opencodeHostCache && Date.now() - opencodeHostCheckedAt < 30000) return opencodeHostCache;

  if (config.opencodeHost) {
    opencodeHostCache = config.opencodeHost;
    opencodeHostCheckedAt = Date.now();
    return opencodeHostCache;
  }

  const host = await new Promise((resolve) => {
    execFile('opencode', ['service', 'status'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const value = (stdout || '').trim().split('\n')[0].trim();
      resolve(/^https?:\/\//.test(value) ? value : null);
    });
  });

  opencodeHostCache = host;
  opencodeHostCheckedAt = Date.now();
  return host;
}

async function opencodeStatus() {
  const host = await discoverOpencodeHost();
  if (!host) {
    return { available: false, reason: 'the opencode service is not running' };
  }
  const password = readServicePassword();
  if (!password) {
    return { available: false, reason: 'no opencode service credentials found' };
  }
  try {
    const res = await fetch(`${host}/api/provider`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { available: false, reason: `opencode service returned ${res.status}` };
    const body = await res.json();
    const providers = (body.data || []).map((p) => p.id);
    return { available: true, host, providers, reason: null };
  } catch (err) {
    return { available: false, reason: `cannot reach the opencode service at ${host}`, detail: String(err.message || err) };
  }
}

/**
 * One-shot text generation through the opencode server.
 *
 * The server owns the provider credentials and the model registry, so this
 * path works with whatever providers the machine is already configured for.
 */
async function opencodeGenerate(prompt, { system = SYSTEM, model } = {}) {
  const host = await discoverOpencodeHost();
  if (!host) throw new Error('the opencode service is not running');
  const password = readServicePassword();
  if (!password) throw new Error('no opencode service credentials found');

  const body = { prompt: system ? `${system}\n\n${prompt}` : prompt };
  if (model) body.model = { id: model.id, providerID: model.provider };

  const res = await fetch(`${host}/api/experimental/generate/text`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ollama.timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`opencode returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const parsed = await res.json();
  return {
    text: (parsed.data?.text || '').trim(),
    tokens: null,
    durationMs: null,
    model: model ? `${model.provider}/${model.id}` : 'opencode',
    backend: 'opencode',
  };
}

/* ------------------------------------------------------------------ */
/* Backend selection                                                   */
/* ------------------------------------------------------------------ */

function backendOrder() {
  const preference = config.ai?.backend || 'auto';
  if (preference === 'ollama') return ['ollama'];
  if (preference === 'opencode') return ['opencode'];
  // Local first: if the machine can answer privately, it should.
  return ['ollama', 'opencode'];
}

/**
 * Generate with the first backend that works.
 *
 * The response records which backend answered, because the difference
 * matters: an Ollama answer never left the machine, an opencode answer used
 * whichever provider the agent runtime is configured for.
 */
export async function generate(prompt, options = {}) {
  const errors = [];

  for (const name of backendOrder()) {
    if (!isHealthy(name)) {
      errors.push(`${name}: marked unhealthy after an earlier failure`);
      continue;
    }
    try {
      if (name === 'ollama') return await ollamaGenerate(prompt, options);
      if (name === 'opencode') return await opencodeGenerate(prompt, options);
    } catch (err) {
      markUnhealthy(name);
      errors.push(`${name}: ${err.message}`);
    }
  }

  throw new Error(`no AI backend could answer. ${errors.join(' | ')}`);
}

/** The state of every backend, for the status chip in the header. */
export async function modelStatus() {
  const [ollama, opencode] = await Promise.all([ollamaStatus(), opencodeStatus()]);
  const backends = { ollama, opencode };

  // Prefer a backend that is both reachable and not currently marked
  // unhealthy, so the status chip names the backend that will actually
  // answer rather than the one that is merely installed.
  let active = null;
  for (const name of backendOrder()) {
    if (backends[name].available && isHealthy(name)) {
      active = name;
      break;
    }
  }
  if (!active) {
    for (const name of backendOrder()) {
      if (backends[name].available) {
        active = name;
        break;
      }
    }
  }

  return {
    backends,
    active,
    unhealthy: [...unhealthy.keys()],
    model: config.ai?.model?.id || config.ollama.model,
    available: active !== null,
  };
}

/* ------------------------------------------------------------------ */
/* The tasks the panel offers                                          */
/* ------------------------------------------------------------------ */

/**
 * Trim text to a byte budget.
 *
 * We budget in bytes rather than tokens because the backends give us no
 * reliable tokenizer, and a byte budget is the only limit we can enforce.
 * The cut is made at a line boundary so the model never sees half a diff.
 */
export function clip(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(0, maxBytes).toString('utf8');
  const cut = slice.lastIndexOf('\n');
  const kept = cut > maxBytes * 0.6 ? slice.slice(0, cut) : slice;
  return `${kept}\n\n[... truncated at ${maxBytes} bytes ...]`;
}

export async function summarizeSession({ title, transcript, status, model }) {
  const transcriptText = clip(
    transcript.map((m) => `${m.type === 'user' ? 'Human' : 'Agent'}: ${m.text}`).join('\n\n'),
    24000,
  );

  const prompt = `Summarise this AI agent working session so that a human maintainer can understand, at a glance, what the agent actually did.

Session title: ${title}

Repository state when the session finished:
${status ? status : '(not available)'}

Transcript:
${transcriptText}

Answer these, in this order, using short bullet points:
1. What was asked
2. What the agent did, step by step
3. What it changed on disk, if the transcript says
4. What was left unfinished, uncertain, or still needs a human check`;

  return generate(prompt, { model });
}

export async function reviewDiff({ description, diffText, branch, base, model }) {
  const clipped = clip(diffText, 32000);

  const prompt = `Review this change as a careful senior maintainer would.

${branch && base ? `Branch: ${branch}\nBase: ${base}\n` : ''}${description ? `Description: ${description}\n` : ''}
Diff:
${clipped}

Report, in this order:
1. Intent — what this change appears to be trying to do, in one or two sentences
2. Correctness — anything that looks wrong, incomplete, or likely to break. Point at specific files and lines.
3. Risk — what could go wrong if this merges as-is
4. Missing — what a reviewer would ask for that is not here

Be blunt. If the change looks fine, say so in one line and stop. Do not invent problems to appear thorough.`;

  return generate(prompt, { model });
}

export async function draftCommitMessage({ diffText, status, model }) {
  const clipped = clip(diffText, 24000);

  const prompt = `Write a commit message for the change below.

${status ? `Working tree state:\n${status}\n` : ''}
Diff:
${clipped}

Produce exactly two things:
A conventional-commit subject line, at most 72 characters, in the form type(scope): summary
Then a body: a short paragraph explaining what changed and why, wrapped at 72 characters. No bullet points, no headers, no "This commit" phrasing.`;

  return generate(prompt, { model });
}

export async function explainBranch({ branch, base, commits, diffStat, model }) {
  const commitList = commits
    .map((c) => `- ${c.sha.slice(0, 8)} ${c.subject} (${c.author}, ${new Date(c.at * 1000).toISOString().slice(0, 10)})`)
    .join('\n');

  const prompt = `Explain what this branch is for, and how it relates to its base.

Branch: ${branch}
Base: ${base}

Commits on the branch:
${commitList || '(none)'}

Files touched:
${diffStat || '(unknown)'}

In three short sections:
1. Purpose — what this branch is trying to achieve
2. Relationship to base — does it extend, replace, or diverge from ${base}
3. Readiness — is this ready to merge, and what is missing`;

  return generate(prompt, { model });
}
