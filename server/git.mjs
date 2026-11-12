// All Git access lives here.
//
// Reason never builds a Git command line out of anything a browser sent us:
// every call site passes a fixed argument array, and the only variable parts
// are values that have already been validated against the repository (a commit
// SHA, a branch that exists, a path that is inside the repo).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const UNIT = '\x1f'; // field separator inside a single git record
const RECORD = '\x00'; // record separator between git records

/**
 * Run git in a repository.
 * Arguments are passed as an array, never through a shell, so no value in
 * Reason can be interpreted as shell syntax.
 */
export function git(args, cwd, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? -2 : code, stdout, stderr });
    });
  });
}

export async function gitOut(args, cwd, opts) {
  const res = await git(args, cwd, opts);
  if (res.code !== 0) {
    const err = new Error(res.stderr.trim() || `git ${args[0]} failed with code ${res.code}`);
    err.gitArgs = args;
    err.code = res.code;
    throw err;
  }
  return res.stdout;
}

/**
 * Walk a set of roots looking for Git repositories.
 *
 * A directory containing a `.git` entry is a repository, but the walk keeps
 * going rather than stopping there — a directory can be an empty repository
 * that holds other repositories inside it, and stopping would hide every one
 * of them. `~/.ai/.src` is exactly that case: it has an initialised but
 * commitless `.git`, and all eighteen real repositories live beneath it.
 */
export async function discoverRepos(roots, skipDirs) {
  const found = [];
  const seen = new Set();
  let visited = 0;
  const VISIT_LIMIT = 60000;

  async function walk(dir, depth) {
    if (depth > 8 || visited > VISIT_LIMIT) return;
    visited++;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === '.git')) {
      const real = await fs.realpath(dir).catch(() => dir);
      if (!seen.has(real)) {
        seen.add(real);
        found.push(real);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirs.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.')) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  for (const root of roots) {
    const st = await fs.stat(root).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) await walk(root, 0);
  }

  found.sort();
  return found;
}

/** A repository with no commits has an unborn HEAD; it is not worth showing. */
export function isUsableRepo(info) {
  return Boolean(info && info.head);
}

function splitRecords(text) {
  return text.split(RECORD).filter((r) => r.length > 0);
}

/**
 * Split newline-separated records.
 *
 * `for-each-ref` separates its records with newlines, unlike `git log -z`.
 * A branch name cannot contain a newline, so splitting on it is safe.
 */
function splitLines(text) {
  return text.split('\n').filter((r) => r.length > 0);
}

/**
 * Split a `for-each-ref` record into fields.
 *
 * `for-each-ref` does not understand the `%x1f` escape that `git log` uses;
 * it understands `%00`. The reference name, object name and upstream are all
 * NUL-safe, and the subject is a single line, so NUL is a sound separator.
 */
function splitRefFields(record) {
  return record.split('\x00');
}

function splitFields(record) {
  const parts = record.split(UNIT);
  // The format string ends with a separator, so the last field is empty.
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Parse `git status --porcelain=v1 -z` output into structured entries.
 * The -z form is used because paths with spaces or newlines are legal and
 * the newline form would split them apart.
 */
export function parseStatus(text) {
  const entries = [];
  const fields = text.split('\x00');
  for (let i = 0; i < fields.length; i++) {
    const raw = fields[i];
    if (!raw) continue;
    const code = raw.slice(0, 2);
    const file = raw.slice(3);
    const entry = { code, file, staged: false, unstaged: false, untracked: false };
    if (code === '??') {
      entry.untracked = true;
    } else {
      entry.staged = code[0] !== ' ' && code[0] !== '?';
      entry.unstaged = code[1] !== ' ' && code[1] !== '?';
    }
    // A rename record is followed by the original path in the same -z stream.
    if (code[0] === 'R' || code[0] === 'C') {
      entry.renamedFrom = fields[++i] ?? null;
    }
    entries.push(entry);
  }
  return entries;
}

/** Everything Reason shows about a repository at a glance. */
export async function repoInfo(repoPath, baseBranches) {
  const [branchRes, headRes, statusRes, stashRes, lastRes] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath),
    git(['rev-parse', 'HEAD'], repoPath),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoPath),
    git(['stash', 'list'], repoPath),
    git(['log', '-1', '--format=%H%x1f%an%x1f%at%x1f%s'], repoPath),
  ]);

  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
  const head = headRes.code === 0 ? headRes.stdout.trim() : null;

  const status = parseStatus(statusRes.stdout);
  const dirtyFiles = status.length;
  const staged = status.filter((s) => s.staged).length;
  const unstaged = status.filter((s) => s.unstaged).length;
  const untracked = status.filter((s) => s.untracked).length;

  const stashLines = stashRes.stdout.split('\n').filter(Boolean);

  let lastCommit = null;
  if (lastRes.code === 0) {
    const [sha, author, at, subject] = splitFields(lastRes.stdout.trim());
    lastCommit = { sha, author, at: Number(at), subject };
  }

  // Which branch counts as the base for this repository?
  const branches = await branchList(repoPath);
  const names = branches.map((b) => b.name);
  const base = baseBranches.find((b) => names.includes(b)) || null;

  let ahead = null;
  let behind = null;
  let upstream = null;
  if (branch) {
    const current = branches.find((b) => b.name === branch);
    upstream = current?.upstream || null;
    if (current && current.upstream) {
      const counts = await aheadBehind(repoPath, current.upstream, branch);
      ahead = counts.ahead;
      behind = counts.behind;
    } else if (base && base !== branch) {
      const counts = await aheadBehind(repoPath, base, branch);
      ahead = counts.ahead;
      behind = counts.behind;
    }
  }

  const remotes = await gitOut(['remote'], repoPath)
    .then((out) => out.split('\n').filter(Boolean))
    .catch(() => []);

  return {
    path: repoPath,
    name: path.basename(repoPath),
    branch,
    head,
    base,
    upstream,
    ahead,
    behind,
    detached: branch === null,
    dirtyFiles,
    staged,
    unstaged,
    untracked,
    stashes: stashLines.length,
    stashList: stashLines,
    lastCommit,
    remotes,
    branchCount: branches.length,
  };
}

/**
 * Commits on `head` that are not on `base`, and the other way round.
 * `rev-list --left-right --count` reports left (base only) first.
 */
export async function aheadBehind(repoPath, base, head) {
  const res = await git(['rev-list', '--left-right', '--count', `${base}...${head}`], repoPath);
  if (res.code !== 0) return { ahead: null, behind: null };
  const [behind, ahead] = res.stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

export async function branchList(repoPath) {
  const raw = await gitOut(
    [
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(committerdate:unix)%00%(subject)%00%(HEAD)',
      'refs/heads',
    ],
    repoPath,
  ).catch(() => '');

  return splitLines(raw).map((record) => {
    const [name, sha, upstream, at, subject, head] = splitRefFields(record);
    return {
      name,
      sha,
      upstream: upstream || null,
      at: Number(at),
      subject,
      current: head === '*',
    };
  });
}

/**
 * Every reference in the repository, used to label tips on the graph.
 */
export async function refMap(repoPath) {
  const raw = await gitOut(
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(refname:short)', 'refs/heads', 'refs/remotes'],
    repoPath,
  ).catch(() => '');

  const map = {};
  for (const record of splitLines(raw)) {
    const [full, sha, short] = splitRefFields(record);
    if (!map[sha]) map[sha] = [];
    map[sha].push({ full, short, remote: full.startsWith('refs/remotes/') });
  }
  return map;
}

/**
 * Commit history for the graph, in topological order.
 *
 * Topological order guarantees a parent is always listed after its children,
 * which is what lets the browser draw edges that only ever point downwards.
 */
export async function commitLog(repoPath, { limit = 400, ref = '--all' } = {}) {
  const format = [
    '%H',
    '%P',
    '%an',
    '%ae',
    '%at',
    '%cI',
    '%D',
    '%s',
    '%b',
  ].join('%x1f');

  const raw = await gitOut(
    ['log', ref, '--topo-order', '-z', `--max-count=${limit}`, `--format=${format}`],
    repoPath,
  );

  const commits = splitRecords(raw).map((record) => {
    const fields = splitFields(record);
    const [sha, parents, author, email, at, iso, refs, subject, body] = fields;
    return {
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      at: Number(at),
      iso,
      refs: refs || '',
      subject,
      body: (body || '').trim(),
    };
  });

  const refs = await refMap(repoPath);
  for (const commit of commits) {
    commit.refs = refs[commit.sha] || [];
  }

  return commits;
}

export async function commitDetail(repoPath, sha) {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error('not a commit sha');

  const raw = await gitOut(
    ['show', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cI%x1f%s%x1f%b', '--no-patch', sha],
    repoPath,
  );
  const [full, parents, author, email, at, iso, subject, body] = splitFields(raw.trim());

  const stat = await gitOut(['show', '--stat=200', '--format=', sha], repoPath).catch(() => '');
  const files = parseStat(stat);
  const diff = await gitOut(['show', '--format=', '--no-color', sha], repoPath, { timeout: 60000 });

  return {
    sha: full,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author,
    email,
    at: Number(at),
    iso,
    subject,
    body: (body || '').trim(),
    files,
    diff,
  };
}

/** Parse `git show --stat` output into per-file line counts. */
export function parseStat(text) {
  const files = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)\s*$/);
    if (m) {
      files.push({ file: m[1], insertions: Number(m[2]), marker: m[3] });
      continue;
    }
    const b = line.match(/^\s*(.+?)\s+\|\s+Bin\s+(.+)$/);
    if (b) files.push({ file: b[1], insertions: 0, marker: b[2] });
  }
  return files;
}

export async function diffBetween(repoPath, base, head) {
  const range = `${base}...${head}`;
  const diff = await gitOut(['diff', '--no-color', range], repoPath, { timeout: 60000 });
  const stat = await gitOut(['diff', '--stat=200', range], repoPath).catch(() => '');
  const nameStatus = await gitOut(['diff', '--name-status', range], repoPath).catch(() => '');

  const files = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split('\t');
      return { status, file: file.split('\t').pop() };
    });

  return { base, head, diff, stat, files };
}

/**
 * The working tree as it stands: everything that differs from HEAD,
 * including untracked files.
 *
 * `git diff HEAD` covers both staged and unstaged changes to tracked files
 * in one diff, which is what a reviewer wants to see — not two separate
 * diffs that have to be mentally combined.
 */
export async function worktreeDiff(repoPath) {
  const statusRes = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoPath);
  const status = parseStatus(statusRes.stdout);

  const tracked = await gitOut(['diff', '--no-color', 'HEAD'], repoPath, { timeout: 60000 }).catch(
    () => '',
  );

  // Untracked files have no diff, so we show them as empty additions.
  const untracked = status.filter((s) => s.untracked);
  let untrackedBlocks = '';
  for (const entry of untracked) {
    const numstat = await gitOut(['diff', '--no-index', '--numstat', '/dev/null', entry.file], repoPath).catch(
      () => '',
    );
    const parts = numstat.split('\t');
    const added = parts[0] && parts[0] !== '-' ? parts[0] : '0';
    untrackedBlocks += `diff --git a/${entry.file} b/${entry.file}\nnew file mode 100644\n--- /dev/null\n+++ b/${entry.file}\n@@ -0,0 +1,${added} @@\n`;
  }

  return {
    status,
    diff: tracked + untrackedBlocks,
    untracked: untracked.map((e) => e.file),
  };
}

/**
 * Turn a unified diff into structured hunks so the browser can render it
 * without having to parse diff syntax a second time.
 */
export function parseDiff(text) {
  const files = [];
  if (!text) return files;

  const lines = text.split('\n');
  let file = null;
  let hunk = null;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = {
        oldPath: m ? m[1] : null,
        newPath: m ? m[2] : null,
        status: 'modified',
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from') || line.startsWith('rename to')) file.status = 'renamed';
    else if (line.startsWith('Binary files')) file.binary = true;
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      hunk = {
        header: line,
        oldStart: m ? Number(m[1]) : 0,
        oldLines: m && m[2] !== undefined ? Number(m[2]) : 1,
        newStart: m ? Number(m[3]) : 0,
        newLines: m && m[4] !== undefined ? Number(m[4]) : 1,
        section: m ? m[5].trim() : '',
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && /^[ +\-]/.test(line)) {
      hunk.lines.push({ kind: line[0], text: line.slice(1) });
    }
  }

  return files;
}
