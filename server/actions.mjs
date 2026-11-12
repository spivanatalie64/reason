// Guarded Git mutations.
//
// Two rules hold for everything in this file:
//
//   1. No browser-supplied string ever becomes a Git argument list on its own.
//      Every action validates its inputs against what the repository actually
//      contains before building the command.
//   2. Nothing runs until the caller has seen a preview and confirmed it.
//
// A preview is produced by running the same code path with `confirm: false`,
// so what is shown is exactly what would run.

import { git, gitOut, parseStatus } from './git.mjs';

class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const SAFE_SHA = /^[0-9a-f]{7,40}$/;

/** Refuse to touch a repository that is mid-operation. */
async function assertCleanState(repoPath) {
  const probes = [
    ['MERGE_HEAD', 'a merge is in progress'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
    ['REVERT_HEAD', 'a revert is in progress'],
    ['rebase-merge', 'a rebase is in progress'],
    ['rebase-apply', 'a rebase is in progress'],
  ];
  for (const [name, message] of probes) {
    const res = await git(['rev-parse', '--git-path', name], repoPath);
    if (res.code !== 0) continue;
    const res2 = await git(['rev-parse', '--verify', '--quiet', res.stdout.trim()], repoPath);
    if (res2.code === 0) {
      throw new ActionError(`Refusing to act: ${message} in ${repoPath}. Finish it first.`, 409);
    }
  }
}

async function currentStatus(repoPath) {
  const res = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoPath);
  return parseStatus(res.stdout);
}

function validateBranchName(name) {
  if (typeof name !== 'string' || !SAFE_BRANCH.test(name)) {
    throw new ActionError(`Not a usable branch name: ${JSON.stringify(name)}`);
  }
  if (name.includes('..') || name.endsWith('/') || name.includes('//')) {
    throw new ActionError(`Not a usable branch name: ${name}`);
  }
  return name;
}

function validateSha(sha) {
  if (typeof sha !== 'string' || !SAFE_SHA.test(sha)) {
    throw new ActionError(`Not a commit sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

/** The `git` invocation as a single readable string, for display only. */
function describeCommand(args) {
  return `git ${args.map((a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`;
}

const actions = {
  stage: {
    label: 'Stage files',
    async build(repoPath, args) {
      const status = await currentStatus(repoPath);
      const known = new Set(status.map((s) => s.file));
      let files = args.files;
      if (!files || files.length === 0) {
        files = status.filter((s) => s.untracked || s.unstaged).map((s) => s.file);
      }
      for (const f of files) {
        if (!known.has(f)) throw new ActionError(`Not a changed file in this repository: ${f}`);
      }
      if (!files.length) throw new ActionError('Nothing to stage.');
      return { args: ['add', '--', ...files], note: `Stages ${files.length} file(s).` };
    },
  },

  unstage: {
    label: 'Unstage files',
    async build(repoPath, args) {
      const status = await currentStatus(repoPath);
      const staged = status.filter((s) => s.staged).map((s) => s.file);
      const files = args.files && args.files.length ? args.files : staged;
      for (const f of files) {
        if (!staged.includes(f)) throw new ActionError(`Not a staged file in this repository: ${f}`);
      }
      if (!files.length) throw new ActionError('Nothing is staged.');
      return { args: ['restore', '--staged', '--', ...files], note: `Unstages ${files.length} file(s).` };
    },
  },

  commit: {
    label: 'Commit staged changes',
    async build(repoPath, args) {
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message) throw new ActionError('A commit message is required.');
      const status = await currentStatus(repoPath);
      const staged = status.filter((s) => s.staged);
      if (!staged.length) throw new ActionError('Nothing is staged to commit.');
      return {
        args: ['commit', '-m', message],
        note: `Commits ${staged.length} staged file(s).`,
      };
    },
  },

  branch: {
    label: 'Create branch',
    async build(repoPath, args) {
      const name = validateBranchName(args.name);
      const from = args.from ? validateBranchName(args.from) : null;
      const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoPath);
      if (exists.code === 0) throw new ActionError(`Branch already exists: ${name}`);
      const status = await currentStatus(repoPath);
      if (status.length) {
        throw new ActionError(
          'Working tree is not clean. Commit or stash the current changes before branching.',
        );
      }
      const argv = ['switch', '-c', name];
      if (from) argv.push(from);
      return { args: argv, note: `Creates and switches to ${name}.` };
    },
  },

  checkout: {
    label: 'Switch branch',
    async build(repoPath, args) {
      const name = validateBranchName(args.name);
      const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoPath);
      if (exists.code !== 0) throw new ActionError(`No such branch: ${name}`);
      const status = await currentStatus(repoPath);
      if (status.length) {
        throw new ActionError('Working tree has uncommitted changes; switching would carry them over.');
      }
      return { args: ['switch', name], note: `Switches to ${name}.` };
    },
  },

  merge: {
    label: 'Merge branch',
    async build(repoPath, args) {
      const name = validateBranchName(args.name);
      const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repoPath);
      if (exists.code !== 0) throw new ActionError(`No such branch: ${name}`);

      const current = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoPath)).stdout.trim();
      if (current === name) throw new ActionError(`Already on ${name}.`);

      const head = (await git(['rev-parse', 'HEAD'], repoPath)).stdout.trim();
      const other = (await git(['rev-parse', name], repoPath)).stdout.trim();

      const mergeBase = (await git(['merge-base', head, other], repoPath)).stdout.trim();
      const incoming = await gitOut(
        ['log', '--oneline', '--no-decorate', `${mergeBase}..${other}`],
        repoPath,
      ).catch(() => '');

      // git merge-tree tells us whether the merge would conflict without
      // touching the working tree at all.
      const tree = await git(['merge-tree', '--write-tree', '--name-only', head, other], repoPath);
      let conflicts = [];
      if (tree.code === 1) {
        const lines = tree.stdout.split('\n');
        conflicts = lines.slice(1).filter(Boolean);
      } else if (tree.code !== 0) {
        throw new ActionError(`Could not preview the merge: ${tree.stderr.trim() || 'merge-tree failed'}`);
      }

      const count = incoming.split('\n').filter(Boolean).length;
      return {
        args: ['merge', '--no-ff', name],
        note:
          `Merges ${name} into ${current} — ${count} commit(s) incoming.` +
          (conflicts.length ? ` ${conflicts.length} conflict(s) detected.` : ' No conflicts detected.'),
        preview: {
          incomingCommits: incoming.split('\n').filter(Boolean),
          conflicts,
          mergeBase,
          current,
        },
      };
    },
  },

  cherryPick: {
    label: 'Cherry-pick commit',
    async build(repoPath, args) {
      const sha = validateSha(args.sha);
      const exists = await git(['cat-file', '-e', `${sha}^{commit}`], repoPath);
      if (exists.code !== 0) throw new ActionError(`No such commit: ${sha}`);
      const subject = (await gitOut(['log', '-1', '--format=%s', sha], repoPath)).trim();
      return { args: ['cherry-pick', sha], note: `Cherry-picks ${sha.slice(0, 8)} — ${subject}` };
    },
  },

  stash: {
    label: 'Stash changes',
    async build(repoPath, args) {
      const status = await currentStatus(repoPath);
      if (!status.length) throw new ActionError('Working tree is clean; nothing to stash.');
      const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : null;
      const argv = ['stash', 'push'];
      if (message) argv.push('-m', message);
      return { args: argv, note: `Stashes ${status.length} change(s).` };
    },
  },

  stashPop: {
    label: 'Restore stashed changes',
    async build(repoPath, args) {
      const list = (await git(['stash', 'list'], repoPath)).stdout.split('\n').filter(Boolean);
      if (!list.length) throw new ActionError('There are no stashes.');
      const index = Number.isInteger(args.index) ? args.index : 0;
      if (index < 0 || index >= list.length) throw new ActionError(`No stash at position ${index}.`);
      return {
        args: ['stash', 'pop', `stash@{${index}}`],
        note: `Restores ${list[index].trim()}`,
      };
    },
  },
};

/**
 * Run — or preview — an action.
 *
 * `confirm` is the only thing separating a preview from an execution, and the
 * command that gets built is identical either way.
 */
export async function performAction(repoPath, name, args = {}, confirm = false) {
  const action = actions[name];
  if (!action) {
    throw new ActionError(`Unknown action: ${name}`, 404);
  }

  await assertCleanState(repoPath);

  const built = await action.build(repoPath, args);
  const command = describeCommand(built.args);

  if (!confirm) {
    return {
      requiresConfirmation: true,
      action: name,
      label: action.label,
      command,
      note: built.note,
      preview: built.preview || null,
    };
  }

  const res = await git(built.args, repoPath, { timeout: 120000 });
  const result = {
    action: name,
    label: action.label,
    command,
    note: built.note,
    confirmed: true,
    ok: res.code === 0,
    output: (res.stdout || '') + (res.stderr || ''),
  };

  if (res.code !== 0) {
    // A failed merge or cherry-pick leaves the repository mid-operation.
    // Say so plainly rather than pretending the tree is clean.
    result.error = res.stderr.trim() || `git exited with code ${res.code}`;
    result.recovery = 'The repository may be mid-operation. Check `git status` before continuing.';
  }

  return result;
}

export function actionCatalogue() {
  return Object.entries(actions).map(([name, action]) => ({ name, label: action.label }));
}
