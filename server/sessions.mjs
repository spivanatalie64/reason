// Read-only access to the opencode session database.
//
// The database is the record of what the agents actually did: which
// directory they were working in, what they were asked, what they said,
// what they changed. It is the other half of what Reason shows — a Git
// client tells you the state of the work, this tells you the intent behind it.
//
// The file is opened read-only. Reason never writes to it.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db = null;
let dbPath = null;

export function openSessions(databasePath) {
  if (db && dbPath === databasePath) return db;
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
  if (!fs.existsSync(databasePath)) {
    dbPath = null;
    return null;
  }
  db = new DatabaseSync(databasePath, { readOnly: true });
  dbPath = databasePath;
  return db;
}

export function sessionsAvailable(databasePath) {
  return Boolean(openSessions(databasePath));
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Pull the readable text out of a message blob.
 *
 * opencode stores several shapes: user messages carry a plain `text`, assistant
 * messages carry an array of content parts, and system messages carry notices.
 * We only want the human and model words, not tool payloads.
 */
export function messageText(data) {
  const parsed = parseJson(data);
  if (!parsed) return '';

  if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();

  const parts = [];
  for (const part of parsed.content || []) {
    if (part.type === 'text' && part.text) parts.push(part.text);
  }
  if (parts.length) return parts.join('\n\n').trim();

  if (typeof parsed.content === 'string') return parsed.content.trim();
  return '';
}

/**
 * Work out which repository a session belongs to.
 *
 * A session's directory is where the agent was started, which is not
 * necessarily a repository root: it can be a subdirectory of a repo, the
 * directory that contains several repos, or somewhere unrelated entirely.
 * The longest matching prefix wins, because a repo nested inside another
 * working tree is the more specific answer.
 */
export function resolveScope(directory, repoPaths) {
  const dir = path.resolve(directory);
  const matches = repoPaths
    .filter((repo) => dir === repo || dir.startsWith(repo + path.sep))
    .sort((a, b) => b.length - a.length);

  if (matches.length) {
    return { scope: 'repo', repoPath: matches[0], repos: [matches[0]] };
  }

  // The session directory contains repositories but is not one.
  const parents = repoPaths.filter(
    (repo) => repo.startsWith(dir + path.sep),
  );
  if (parents.length) {
    return { scope: 'workspace', repoPath: null, repos: parents };
  }

  return { scope: 'none', repoPath: null, repos: [] };
}

const SESSION_COLUMNS = `
  s.id, s.title, s.directory, s.agent, s.model, s.version,
  s.time_created, s.time_updated, s.time_idle, s.time_busy, s.idle_outcome,
  s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning,
  s.tokens_cache_read, s.tokens_cache_write,
  s.summary_files, s.summary_additions, s.summary_deletions,
  s.parent_id, s.fork_session_id, s.share_url
`;

/**
 * All sessions, newest activity first.
 *
 * `repoPaths` is the set of known repository roots; it is used to attribute
 * each session to a repository.
 */
export function listSessions(databasePath, repoPaths) {
  const conn = openSessions(databasePath);
  if (!conn) return [];

  const rows = conn
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM session_v2 s ORDER BY s.time_updated DESC`,
    )
    .all();

  return rows.map((row) => decorate(row, repoPaths));
}

function decorate(row, repoPaths) {
  const scope = resolveScope(row.directory, repoPaths);
  const model = parseJson(row.model);
  const busy = row.time_busy ?? 0;
  const idle = row.time_idle ?? 0;

  let state = 'stale';
  if (busy > idle) state = 'running';
  else if (row.idle_outcome) state = row.idle_outcome === 'succeeded' ? 'done' : 'stopped';
  else if (busy) state = 'idle';

  return {
    id: row.id,
    title: row.title || '(untitled session)',
    directory: row.directory,
    agent: row.agent || null,
    model: model ? { id: model.id, provider: model.providerID, variant: model.variant || null } : null,
    version: row.version,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    busyAt: row.time_busy,
    idleAt: row.time_idle,
    idleOutcome: row.idle_outcome,
    state,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
    },
    summary: {
      files: row.summary_files,
      additions: row.summary_additions,
      deletions: row.summary_deletions,
    },
    parentId: row.parent_id,
    forkSessionId: row.fork_session_id,
    shareUrl: row.share_url,
    scope: scope.scope,
    repoPath: scope.repoPath,
    repoPaths: scope.repos,
  };
}

/** The transcript of one session: every user and assistant message, in order. */
export function sessionTranscript(databasePath, sessionId) {
  const conn = openSessions(databasePath);
  if (!conn) return [];

  const rows = conn
    .prepare(
      `SELECT id, type, seq, time_created, data
       FROM session_message
       WHERE session_id = ? AND type IN ('user','assistant','system','synthetic')
       ORDER BY seq ASC`,
    )
    .all(sessionId);

  return rows
    .map((row) => {
      const parsed = parseJson(row.data, {});
      const text = messageText(row.data);
      return {
        id: row.id,
        type: row.type,
        seq: row.seq,
        at: row.time_created,
        text,
        agent: parsed.agent || null,
        model: parsed.model ? parsed.model.id : null,
      };
    })
    .filter((m) => m.text || m.type === 'system');
}

/** The most recent thing the agent said in a session. */
export function lastAgentMessage(databasePath, sessionId) {
  const conn = openSessions(databasePath);
  if (!conn) return null;

  const row = conn
    .prepare(
      `SELECT data, time_created FROM session_message
       WHERE session_id = ? AND type = 'assistant'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(sessionId);

  if (!row) return null;
  const text = messageText(row.data);
  if (!text) return null;
  return { at: row.time_created, text };
}
