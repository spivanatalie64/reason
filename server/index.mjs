// The Reason server.
//
// One process, four jobs:
//   - serve the dashboard
//   - answer questions about repositories and agent sessions
//   - run the guarded Git actions
//   - push changes to the browser over server-sent events

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.mjs';
import {
  commitDetail,
  commitLog,
  diffBetween,
  discoverRepos,
  git,
  gitOut,
  parseDiff,
  repoInfo,
  branchList,
  worktreeDiff,
} from './git.mjs';
import {
  listSessions,
  lastAgentMessage,
  sessionTranscript,
  sessionsAvailable,
} from './sessions.mjs';
import * as ai from './ai.mjs';
import { performAction, actionCatalogue } from './actions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..', 'web');

/* ------------------------------------------------------------------ */
/* Repository store                                                    */
/* ------------------------------------------------------------------ */

/**
 * A cheap fingerprint of a repository.
 *
 * Three Git calls instead of the dozen a full status check costs, because
 * this runs for every repository on every poll tick. The branch line that
 * `git status -b` prints carries the ahead/behind counts, so the header
 * record alone is enough to notice a branch that moved.
 */
async function fingerprint(repoPath) {
  const [statusRes, headRes, stashRes] = await Promise.all([
    git(['status', '--porcelain=v1', '-b', '-z'], repoPath),
    git(['rev-parse', 'HEAD'], repoPath),
    git(['stash', 'list'], repoPath),
  ]);

  const records = statusRes.stdout.split('\x00').filter((r) => r.length > 0);
  const header = records.length && records[0].startsWith('##') ? records[0] : '';
  const entries = records.filter((r) => !r.startsWith('##'));

  return [
    header,
    entries.join('\x00'),
    headRes.stdout.trim(),
    String(stashRes.stdout.split('\n').filter(Boolean).length),
  ].join('|');
}

class RepoStore {
  constructor() {
    this.repos = new Map(); // path -> { info, fingerprint, at }
    this.lastScan = 0;
    this.scanning = null;
  }

  get list() {
    return [...this.repos.values()];
  }

  async scan({ force = false } = {}) {
    const age = Date.now() - this.lastScan;
    if (!force && age < 2000 && this.repos.size) return this.list;
    if (this.scanning) return this.scanning;

    this.scanning = (async () => {
      const paths = await discoverRepos(config.roots, config.skipDirs);
      const seen = new Set(paths);

      for (const key of [...this.repos.keys()]) {
        if (!seen.has(key)) this.repos.delete(key);
      }

      const limit = 6;
      for (let i = 0; i < paths.length; i += limit) {
        const slice = paths.slice(i, i + limit);
        const results = await Promise.all(
          slice.map(async (repoPath) => {
            const info = await repoInfo(repoPath, config.baseBranches).catch(() => null);
            const print = await fingerprint(repoPath).catch(() => '');
            return { repoPath, info, print };
          }),
        );
        for (const { repoPath, info, print } of results) {
          // A commitless repository is an empty shell, not something to show.
          if (!info || !info.head) continue;
          const existing = this.repos.get(repoPath);
          this.repos.set(repoPath, {
            info,
            fingerprint: print,
            at: Date.now(),
            changed: !existing || existing.fingerprint !== print,
          });
        }
      }

      this.lastScan = Date.now();
      return this.list;
    })();

    try {
      return await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  /** Repository paths, used to attribute agent sessions to repositories. */
  paths() {
    return [...this.repos.keys()];
  }
}

const store = new RepoStore();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function repoId(repoPath) {
  return Buffer.from(repoPath, 'utf8').toString('base64url');
}

function repoFromId(id) {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8');
    // Never act on a path that was not discovered on this machine.
    if (!store.paths().includes(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(webRoot, rel);
  // Refuse to serve anything outside the web directory.
  if (!target.startsWith(webRoot)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

/* ------------------------------------------------------------------ */
/* Live updates                                                        */
/* ------------------------------------------------------------------ */

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

let lastFingerprints = new Map();

async function pollLoop() {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    try {
      const repos = await store.scan();
      const changed = [];
      for (const repo of repos) {
        const before = lastFingerprints.get(repo.info.path);
        if (before !== repo.fingerprint) {
          if (before !== undefined) changed.push(repo.info.path);
          lastFingerprints.set(repo.info.path, repo.fingerprint);
        }
      }
      for (const key of [...lastFingerprints.keys()]) {
        if (!repos.some((r) => r.info.path === key)) lastFingerprints.delete(key);
      }

      if (changed.length) {
        broadcast('repos', { changed });
      }

      const sessions = listSessions(config.opencodeDb, store.paths());
      const sessionPrint = sessions
        .slice(0, 40)
        .map((s) => `${s.id}:${s.updatedAt}:${s.state}`)
        .join(',');
      if (sessionPrint !== lastFingerprints.get('__sessions')) {
        lastFingerprints.set('__sessions', sessionPrint);
        broadcast('sessions', { count: sessions.length });
      }
    } catch (err) {
      console.error('poll error:', err.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Work out which model the AI panel should use.
 *
 * An explicit configuration wins. Otherwise we take the model used by the
 * most recent agent session on this machine: whatever that is, it is a
 * provider and model combination that is known to work here, and it is
 * likely the one the user actually wants to be talking to.
 */
async function resolveModel() {
  if (config.ai.model) return config.ai.model;
  const sessions = listSessions(config.opencodeDb, store.paths());
  for (const session of sessions) {
    if (session.model?.id && session.model?.provider) {
      return { id: session.model.id, provider: session.model.provider };
    }
  }
  return null;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = parts.slice(1);
  const method = req.method;

  if (method === 'GET' && route.length === 1 && route[0] === 'config') {
    return sendJson(res, 200, {
      roots: config.roots,
      home: os.homedir(),
      port: config.port,
      baseBranches: config.baseBranches,
      model: config.ollama.model,
      ollamaHost: config.ollama.host,
      actions: actionCatalogue(),
      sessionsAvailable: sessionsAvailable(config.opencodeDb),
    });
  }

  if (method === 'GET' && route.length === 1 && route[0] === 'overview') {
    await store.scan();
    const repos = store.list.map((r) => r.info);
    const sessions = listSessions(config.opencodeDb, store.paths());
    const model = await ai.modelStatus();
    const resolved = await resolveModel();
    return sendJson(res, 200, {
      repos,
      sessions,
      model,
      aiModel: resolved ? `${resolved.provider}/${resolved.id}` : null,
      at: Date.now(),
    });
  }

  if (method === 'GET' && route.length === 1 && route[0] === 'repos') {
    await store.scan();
    return sendJson(res, 200, { repos: store.list.map((r) => r.info) });
  }

  if (route[0] === 'repos' && route.length >= 2) {
    const repoPath = repoFromId(route[1]);
    if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });

    if (method === 'GET' && route.length === 2) {
      const info = await repoInfo(repoPath, config.baseBranches);
      return sendJson(res, 200, info);
    }

    if (method === 'GET' && route[2] === 'branches') {
      const branches = await branchList(repoPath);
      return sendJson(res, 200, { branches });
    }

    if (method === 'GET' && route[2] === 'graph') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || config.maxCommits, config.maxCommits);
      const commits = await commitLog(repoPath, { limit });
      return sendJson(res, 200, { commits, repoPath });
    }

    if (method === 'GET' && route[2] === 'commit' && route[3]) {
      const detail = await commitDetail(repoPath, route[3]);
      detail.filesParsed = parseDiff(detail.diff);
      return sendJson(res, 200, detail);
    }

    if (method === 'GET' && route[2] === 'diff') {
      const base = url.searchParams.get('base');
      const head = url.searchParams.get('head');
      if (!base || !head) return sendJson(res, 400, { error: 'base and head are required' });
      const result = await diffBetween(repoPath, base, head);
      result.filesParsed = parseDiff(result.diff);
      return sendJson(res, 200, result);
    }

    if (method === 'GET' && route[2] === 'worktree') {
      const result = await worktreeDiff(repoPath);
      result.filesParsed = parseDiff(result.diff);
      return sendJson(res, 200, result);
    }
  }

  if (method === 'GET' && route.length === 1 && route[0] === 'models') {
    const sessions = listSessions(config.opencodeDb, store.paths());
    const counts = new Map();
    for (const session of sessions) {
      if (!session.model?.id || !session.model?.provider) continue;
      const key = `${session.model.provider}/${session.model.id}`;
      const entry = counts.get(key) || {
        id: session.model.id,
        provider: session.model.provider,
        label: key,
        sessions: 0,
        lastUsed: 0,
      };
      entry.sessions += 1;
      entry.lastUsed = Math.max(entry.lastUsed, session.updatedAt);
      counts.set(key, entry);
    }
    const models = [...counts.values()].sort((a, b) => b.lastUsed - a.lastUsed);
    return sendJson(res, 200, { models });
  }

  if (route[0] === 'sessions') {
    if (method === 'GET' && route.length === 1) {
      const sessions = listSessions(config.opencodeDb, store.paths());
      return sendJson(res, 200, { sessions });
    }

    if (method === 'GET' && route.length === 2) {
      const transcript = sessionTranscript(config.opencodeDb, route[1]);
      const last = lastAgentMessage(config.opencodeDb, route[1]);
      return sendJson(res, 200, { transcript, last });
    }
  }

  if (method === 'POST' && route[0] === 'ai' && route[1]) {
    const body = await readBody(req);
    const task = route[1];
    const model =
      body.model && body.model.id && body.model.provider
        ? { id: body.model.id, provider: body.model.provider }
        : await resolveModel();

    if (task === 'status') {
      return sendJson(res, 200, await ai.modelStatus());
    }

    if (task === 'summarize-session') {
      const transcript = sessionTranscript(config.opencodeDb, body.sessionId);
      if (!transcript.length) return sendJson(res, 404, { error: 'no transcript for that session' });
      const result = await ai.summarizeSession({
        title: body.title || 'Untitled session',
        transcript,
        status: body.status || null,
        model,
      });
      return sendJson(res, 200, result);
    }

    if (task === 'review-diff') {
      let diffText = body.diff;
      let branch = body.branch || null;
      let base = body.base || null;

      if (!diffText && body.repoId && body.sha) {
        const repoPath = repoFromId(body.repoId);
        if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });
        const detail = await commitDetail(repoPath, body.sha);
        diffText = detail.diff;
      } else if (!diffText && body.repoId && body.base && body.head) {
        const repoPath = repoFromId(body.repoId);
        if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });
        const result = await diffBetween(repoPath, body.base, body.head);
        diffText = result.diff;
        branch = body.head;
        base = body.base;
      }

      if (!diffText) return sendJson(res, 400, { error: 'nothing to review' });
      const result = await ai.reviewDiff({ diffText, description: body.description, branch, base, model });
      return sendJson(res, 200, result);
    }

    if (task === 'commit-message') {
      let diffText = body.diff;
      if (!diffText && body.repoId) {
        const repoPath = repoFromId(body.repoId);
        if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });
        diffText = await gitOut(['diff', 'HEAD'], repoPath, { timeout: 60000 }).catch(() => '');
        const staged = await gitOut(['diff', '--cached'], repoPath, { timeout: 60000 }).catch(() => '');
        diffText = staged || diffText;
      }
      if (!diffText) return sendJson(res, 400, { error: 'nothing to commit' });
      const result = await ai.draftCommitMessage({ diffText, status: body.status || null, model });
      return sendJson(res, 200, result);
    }

    if (task === 'explain-branch') {
      const repoPath = repoFromId(body.repoId);
      if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });
      const base = body.base;
      const head = body.head;
      if (!base || !head) return sendJson(res, 400, { error: 'base and head are required' });

      const mergeBase = (await gitOut(['merge-base', base, head], repoPath)).trim();
      const raw = await gitOut(['log', '--format=%H%x1f%an%x1f%at%x1f%s', `${mergeBase}..${head}`], repoPath).catch(() => '');
      const commits = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, author, at, subject] = line.split('\x1f');
          return { sha, author, at: Number(at), subject };
        });

      const stat = await gitOut(['diff', '--stat', `${mergeBase}..${head}`], repoPath).catch(() => '');
      const result = await ai.explainBranch({ branch: head, base, commits, diffStat: stat, model });
      return sendJson(res, 200, result);
    }

    return sendJson(res, 404, { error: `unknown AI task: ${task}` });
  }

  if (method === 'POST' && route[0] === 'actions' && route[1]) {
    const body = await readBody(req);
    const repoPath = repoFromId(body.repoId);
    if (!repoPath) return sendJson(res, 404, { error: 'no such repository' });
    const result = await performAction(repoPath, route[1], body.args || {}, body.confirm === true);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    console.error(`${req.method} ${url.pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

const port = config.port;
server.listen(port, config.host, () => {
  console.log(`Reason listening on http://${config.host}:${port}`);
  console.log(`Scanning: ${config.roots.join(', ')}`);
  pollLoop();
});
