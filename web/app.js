// Reason — the dashboard.
//
// The board has three columns: repositories on the left, the work in the
// middle, the agents on the right. The middle column answers "what does the
// repository look like", the right column answers "who is doing what to it",
// and the AI panel connects the two.

import { buildGraph, renderGraph, highlightBranch } from '/graph.js';

const state = {
  config: null,
  repos: [],
  sessions: [],
  model: null,
  repoId: null,
  repo: null,
  graph: null,
  branches: [],
  selectedCommit: null,
  selectedSession: null,
  activeTab: 'graph',
  aiModel: null,
  filter: '',
  sessionFilter: '',
  sessionScope: 'all',
  aiTarget: null,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

function repoId(path) {
  return btoa(unescape(encodeURIComponent(path))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromRepoId(id) {
  const padded = id.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(padded)));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error((data && data.error) || `request failed: ${res.status}`);
  return data;
}

/** Collapse the home directory so long paths stay readable in a narrow column. */
function shortenPath(path) {
  const home = state.config?.home;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function ago(ms) {
  if (!ms) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function bytes(n) {
  if (!n) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = n;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${kind ? ` is-${kind}` : ''}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5200);
}

/* ------------------------------------------------------------------ */
/* Rendering: repositories                                             */
/* ------------------------------------------------------------------ */

function renderRepos() {
  const list = $('#repo-list');
  list.textContent = '';

  const filter = state.filter.trim().toLowerCase();
  const repos = state.repos.filter((r) => {
    if (!filter) return true;
    return (
      r.name.toLowerCase().includes(filter) ||
      r.path.toLowerCase().includes(filter) ||
      (r.branch || '').toLowerCase().includes(filter)
    );
  });

  $('#repo-count').textContent = `${state.repos.length} repo${state.repos.length === 1 ? '' : 's'}`;
  $('#repo-total').textContent = `${repos.length} shown`;

  for (const repo of repos) {
    const id = repoId(repo.path);
    const badges = [];

    if (repo.dirtyFiles) badges.push(el('span', { class: 'badge badge-dirty', text: `${repo.dirtyFiles} dirty` }));
    if (repo.ahead) badges.push(el('span', { class: 'badge badge-ahead', text: `↑${repo.ahead}` }));
    if (repo.behind) badges.push(el('span', { class: 'badge badge-behind', text: `↓${repo.behind}` }));
    if (repo.stashes) badges.push(el('span', { class: 'badge badge-stash', text: `${repo.stashes} stash` }));

    const agentCount = state.sessions.filter((s) => s.repoPath === repo.path).length;
    if (agentCount) {
      badges.push(el('span', { class: 'badge', text: `${agentCount} agent${agentCount === 1 ? '' : 's'}` }));
    }

    const item = el(
      'li',
      {
        class: `repo-item${id === state.repoId ? ' is-active' : ''}`,
        onclick: () => selectRepo(repo.path),
      },
      [
        el('div', { class: 'repo-item-top' }, [
          el('span', { class: 'repo-name', text: repo.name }),
          el('span', { class: 'repo-branch', text: repo.branch || 'detached' }),
        ]),
        el('div', { class: 'repo-meta' }, [
          el('span', { text: shortenPath(repo.path) }),
          ...badges,
        ]),
      ],
    );

    list.appendChild(item);
  }

  if (!repos.length) {
    list.appendChild(el('li', { class: 'empty', text: 'No repositories match.' }));
  }
}

/* ------------------------------------------------------------------ */
/* Rendering: graph                                                    */
/* ------------------------------------------------------------------ */

async function loadGraph() {
  if (!state.repoId) return;
  try {
    const data = await api(`/api/repos/${state.repoId}/graph?limit=300`);
    state.graph = buildGraph(data.commits);
    renderGraphView();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderGraphView() {
  const container = $('#graph');
  const empty = $('#graph-empty');

  if (!state.graph || !state.graph.nodes.length) {
    container.textContent = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  renderGraph(container, state.graph, { onSelect: selectCommit });
  highlightBranch(container.querySelector('.graph-svg'), []);
}

async function selectCommit(node) {
  state.selectedCommit = node;
  renderCommitPanel(node);

  // Refresh the AI target so the panel knows what it would be talking about.
  updateAiTarget();
}

function renderCommitPanel(node) {
  const panel = $('#commit-panel');
  panel.textContent = '';

  const meta = el('div', { class: 'commit-meta' }, [
    el('div', { text: `${node.author} · ${ago(node.at * 1000)}` }),
    el('div', { class: 'sha-row' }, [
      el('code', { text: node.sha.slice(0, 12) }),
      el('button', {
        class: 'btn btn-small btn-ghost',
        text: 'copy',
        onclick: () => {
          navigator.clipboard?.writeText(node.sha);
          toast('Commit sha copied');
        },
      }),
    ]),
  ]);

  panel.appendChild(el('h3', { class: 'commit-title', text: node.subject }));
  panel.appendChild(meta);

  if (node.body) {
    panel.appendChild(el('div', { class: 'commit-body muted', text: node.body }));
  }

  if (node.refs && node.refs.length) {
    const refList = el('div', { class: 'repo-meta' }, node.refs.map((r) =>
      el('span', { class: r.remote ? 'muted' : 'repo-branch', text: r.short }),
    ));
    panel.appendChild(refList);
  }

  panel.appendChild(el('div', { class: 'section-title', text: 'Loading changes…' }));

  api(`/api/repos/${state.repoId}/commit/${node.sha}`)
    .then((detail) => {
      // The commit panel is re-rendered wholesale, so drop the placeholder.
      panel.textContent = '';
      panel.appendChild(el('h3', { class: 'commit-title', text: detail.subject }));
      panel.appendChild(
        el('div', { class: 'commit-meta' }, [
          el('div', { text: `${detail.author} <${detail.email}> · ${ago(detail.at * 1000)}` }),
          el('div', { class: 'sha-row' }, [
            el('code', { text: detail.sha }),
            el('button', {
              class: 'btn btn-small btn-ghost',
              text: 'copy',
              onclick: () => {
                navigator.clipboard?.writeText(detail.sha);
                toast('Commit sha copied');
              },
            }),
          ]),
        ]),
      );

      if (detail.body) panel.appendChild(el('div', { class: 'commit-body muted', text: detail.body }));

      const list = el('div', { class: 'file-list' });
      for (const file of detail.filesParsed || []) {
        const added = file.hunks.reduce(
          (n, h) => n + h.lines.filter((l) => l.kind === '+').length,
          0,
        );
        const removed = file.hunks.reduce(
          (n, h) => n + h.lines.filter((l) => l.kind === '-').length,
          0,
        );
        list.appendChild(
          el('div', { class: 'file-row' }, [
            el('span', { class: 'file-path', text: file.newPath || file.oldPath }),
            el('span', { class: 'file-add', text: `+${added}` }),
            el('span', { class: 'file-del', text: `-${removed}` }),
          ]),
        );
      }
      if (detail.filesParsed && detail.filesParsed.length) {
        panel.appendChild(el('div', { class: 'section-title', text: 'Files changed' }));
        panel.appendChild(list);
      }

      const aiButton = el('button', {
        class: 'btn btn-small',
        text: 'Review this change with AI',
        onclick: () => {
          switchSideTab('ai');
          runAi('review-diff', { repoId: state.repoId, sha: node.sha });
        },
      });
      panel.appendChild(el('div', { class: 'row-actions', style: 'margin-top:12px' }, [aiButton]));

      panel.appendChild(renderDiff(detail.filesParsed || []));
      state.selectedCommit = { ...node, detail };
      updateAiTarget();
    })
    .catch((err) => {
      panel.textContent = '';
      panel.appendChild(el('div', { class: 'empty', text: `Could not load commit: ${err.message}` }));
    });
}

/** Render structured diff hunks. */
function renderDiff(files) {
  const container = el('div', { class: 'diff' });
  if (!files || !files.length) {
    container.appendChild(el('div', { class: 'empty', text: 'No textual changes.' }));
    return container;
  }

  for (const file of files) {
    const block = el('div', { class: 'diff-file' });
    block.appendChild(
      el('div', { class: 'diff-file-head', text: file.newPath || file.oldPath || '(unknown)' }),
    );
    if (file.binary) {
      block.appendChild(el('div', { class: 'empty', text: 'Binary file' }));
    }
    for (const hunk of file.hunks) {
      block.appendChild(el('div', { class: 'diff-hunk-head', text: hunk.header }));
      for (const line of hunk.lines) {
        const cls =
          line.kind === '+' ? 'diff-line-add' : line.kind === '-' ? 'diff-line-del' : 'diff-line-ctx';
        block.appendChild(el('div', { class: `diff-line ${cls}`, text: line.text }));
      }
    }
    container.appendChild(block);
  }
  return container;
}

/* ------------------------------------------------------------------ */
/* Rendering: changes / branches / commits                              */
/* ------------------------------------------------------------------ */

async function loadChanges() {
  const container = $('#changes');
  container.textContent = '';
  if (!state.repoId) return;

  try {
    const status = await api(`/api/repos/${state.repoId}`);
    const repo = state.repos.find((r) => r.path === status.path);
    const dirty = (repo && repo.dirtyFiles) || 0;

    if (!dirty) {
      container.appendChild(el('div', { class: 'empty', text: 'Working tree is clean.' }));
      return;
    }

    const diff = await api(`/api/repos/${state.repoId}/worktree`).catch(() => null);

    container.appendChild(el('div', { class: 'section-title', text: 'Working tree' }));
    container.appendChild(
      el('div', { class: 'muted', text: `${dirty} file(s) changed` }),
    );

    container.appendChild(
      el('div', { class: 'row-actions', style: 'margin-top:10px' }, [
        el('button', {
          class: 'btn btn-small',
          text: 'Stage all',
          onclick: () => runAction('stage', {}),
        }),
        el('button', {
          class: 'btn btn-small',
          text: 'Stash',
          onclick: () => runAction('stash', { message: 'reason: manual stash' }),
        }),
        el('button', {
          class: 'btn btn-small',
          text: 'Draft commit message',
          onclick: () => {
            switchSideTab('ai');
            runAi('commit-message', { repoId: state.repoId });
          },
        }),
        el('button', {
          class: 'btn btn-small',
          text: 'Commit staged…',
          onclick: openCommitDialog,
        }),
      ]),
    );

    if (diff && diff.filesParsed) container.appendChild(renderDiff(diff.filesParsed));
  } catch (err) {
    container.appendChild(el('div', { class: 'empty', text: err.message }));
  }
}

async function loadBranches() {
  const container = $('#branches');
  container.textContent = '';
  if (!state.repoId) return;

  try {
    const { branches } = await api(`/api/repos/${state.repoId}/branches`);
    state.branches = branches;

    container.appendChild(
      el('div', { class: 'row-actions', style: 'margin-bottom:10px' }, [
        el('button', {
          class: 'btn btn-small',
          text: 'New branch…',
          onclick: openBranchDialog,
        }),
      ]),
    );

    if (!branches.length) {
      container.appendChild(el('div', { class: 'empty', text: 'No local branches.' }));
      return;
    }

    for (const branch of branches) {
      const counts = el('span', { class: 'branch-counts' });
      if (branch.name === state.repo?.branch) {
        counts.textContent = 'current';
      }

      const row = el('div', { class: 'branch-row' }, [
        el('div', {}, [
          el('div', { class: 'branch-name', text: branch.name }),
          el('div', { class: 'branch-subject', text: branch.subject || '' }),
        ]),
        counts,
        el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn btn-small',
            text: 'Explain',
            onclick: () => {
              switchSideTab('ai');
              runAi('explain-branch', {
                repoId: state.repoId,
                base: state.repo?.base || 'main',
                head: branch.name,
              });
            },
          }),
          el('button', {
            class: 'btn btn-small',
            text: 'Merge',
            onclick: () => runAction('merge', { name: branch.name }),
          }),
        ]),
      ]);
      container.appendChild(row);
    }
  } catch (err) {
    container.appendChild(el('div', { class: 'empty', text: err.message }));
  }
}

async function loadCommits() {
  const container = $('#commits');
  container.textContent = '';
  if (!state.repoId) return;

  if (!state.graph) {
    container.appendChild(el('div', { class: 'empty', text: 'Loading…' }));
    await loadGraph();
  }
  if (!state.graph) return;

  for (const node of state.graph.nodes) {
    container.appendChild(
      el('div', { class: 'branch-row', onclick: () => selectCommit(node) }, [
        el('div', {}, [
          el('div', { class: 'branch-name', text: node.subject }),
          el('div', { class: 'branch-subject', text: `${node.author} · ${ago(node.at * 1000)}` }),
        ]),
        el('span', { class: 'branch-counts', text: node.sha.slice(0, 8) }),
        el('div', { class: 'row-actions' }, [
          el('button', {
            class: 'btn btn-small',
            text: 'Cherry-pick',
            onclick: (event) => {
              event.stopPropagation();
              runAction('cherryPick', { sha: node.sha });
            },
          }),
        ]),
      ]),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Rendering: agents                                                   */
/* ------------------------------------------------------------------ */

function renderSessions() {
  const list = $('#session-list');
  list.textContent = '';

  const filter = state.sessionFilter.trim().toLowerCase();
  let sessions = state.sessions;

  if (state.sessionScope === 'repo') {
    sessions = sessions.filter((s) => s.repoPath === state.repo?.path);
  } else if (state.sessionScope === 'active') {
    sessions = sessions.filter((s) => s.state === 'running' || s.state === 'idle');
  }

  if (filter) {
    sessions = sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(filter) ||
        (s.agent || '').toLowerCase().includes(filter) ||
        (s.model?.id || '').toLowerCase().includes(filter) ||
        s.directory.toLowerCase().includes(filter),
    );
  }

  $('#session-count').textContent = `${state.sessions.length} session${state.sessions.length === 1 ? '' : 's'}`;

  for (const session of sessions) {
    const repoName = session.repoPath
      ? session.repoPath.split('/').pop()
      : session.scope === 'workspace'
        ? 'workspace'
        : 'no repo';

    const tokens = session.tokens.input + session.tokens.output + session.tokens.reasoning;

    // A session whose repository has uncommitted changes is the one to look
    // at first: an agent may have left the tree half-finished.
    const repo = session.repoPath ? state.repos.find((r) => r.path === session.repoPath) : null;
    const dirty = repo && repo.dirtyFiles ? repo.dirtyFiles : 0;

    const item = el(
      'li',
      {
        class: `session-item state-${session.state}${session.id === state.selectedSession ? ' is-active' : ''}`,
        onclick: () => openSession(session),
      },
      [
        el('div', { class: 'session-title' }, [
          el('span', { class: 'session-title-text', text: session.title }),
          el('span', { class: 'state-dot' }),
        ]),
        el('div', { class: 'session-meta' }, [
          el('span', { class: 'session-repo', text: repoName }),
          session.agent ? el('span', { text: session.agent }) : null,
          session.model?.id ? el('span', { text: session.model.id }) : null,
          el('span', { text: `${(tokens / 1000).toFixed(1)}k tok` }),
          el('span', { text: ago(session.updatedAt) }),
          dirty ? el('span', { class: 'badge badge-dirty', text: `${dirty} uncommitted` }) : null,
        ]),
      ],
    );

    list.appendChild(item);
  }

  if (!sessions.length) {
    list.appendChild(el('li', { class: 'empty', text: 'No sessions match.' }));
  }
}

async function openSession(session) {
  state.selectedSession = session.id;
  renderSessions();
  updateAiTarget();

  const drawer = $('#drawer');
  const body = $('#drawer-body');
  drawer.hidden = false;
  $('#drawer-title').textContent = session.title;
  body.textContent = '';
  body.appendChild(el('div', { class: 'empty', text: 'Loading transcript…' }));

  try {
    const { transcript } = await api(`/api/sessions/${session.id}`);
    body.textContent = '';

    body.appendChild(
      el('div', { class: 'session-meta', style: 'margin-bottom:10px' }, [
        el('span', { class: 'session-repo', text: session.directory }),
        session.agent ? el('span', { text: session.agent }) : null,
        session.model?.id ? el('span', { text: session.model.id }) : null,
        el('span', { text: `${session.tokens.input + session.tokens.output + session.tokens.reasoning} tokens` }),
        el('span', { text: `cost $${Number(session.cost || 0).toFixed(4)}` }),
      ]),
    );

    body.appendChild(
      el('div', { class: 'row-actions', style: 'margin-bottom:12px' }, [
        el('button', {
          class: 'btn btn-small',
          text: 'Summarise this session with AI',
          onclick: () => {
            switchSideTab('ai');
            runAi('summarize-session', { sessionId: session.id, title: session.title });
          },
        }),
      ]),
    );

    for (const message of transcript) {
      const cls = message.type === 'user' ? 'msg-human' : message.type === 'assistant' ? 'msg-agent' : '';
      body.appendChild(
        el('div', { class: `msg ${cls}` }, [
          el('div', {
            class: 'msg-role',
            text:
              message.type === 'user'
                ? 'human'
                : message.type === 'assistant'
                  ? `agent${message.agent ? ` (${message.agent})` : ''}`
                  : message.type,
          }),
          el('div', { class: 'msg-body', text: message.text }),
        ]),
      );
    }

    if (!transcript.length) {
      body.appendChild(el('div', { class: 'empty', text: 'This session has no transcript.' }));
    }
  } catch (err) {
    body.textContent = '';
    body.appendChild(el('div', { class: 'empty', text: err.message }));
  }
}

/* ------------------------------------------------------------------ */
/* AI panel                                                            */
/* ------------------------------------------------------------------ */

async function loadModels() {
  const select = $('#ai-model');
  try {
    const { models } = await api('/api/models');
    select.textContent = '';
    for (const model of models) {
      select.appendChild(
        el('option', {
          value: `${model.provider}/${model.id}`,
          text: `${model.label} — ${model.sessions} session${model.sessions === 1 ? '' : 's'}`,
        }),
      );
    }
    if (models.length) {
      state.aiModel = models[0].label;
      select.value = models[0].label;
    } else {
      select.appendChild(el('option', { value: '', text: 'no models seen yet' }));
    }
  } catch {
    select.appendChild(el('option', { value: '', text: 'model list unavailable' }));
  }
}

function selectedModel() {
  const value = $('#ai-model').value;
  if (!value) return null;
  const slash = value.indexOf('/');
  if (slash === -1) return null;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function updateAiTarget() {
  const target = $('#ai-target');
  const actions = $('#ai-actions');
  actions.textContent = '';

  const buttons = [];

  if (state.selectedCommit) {
    target.textContent = `Commit ${state.selectedCommit.sha.slice(0, 8)} — ${state.selectedCommit.subject}`;
    buttons.push({
      label: 'Review this change',
      task: 'review-diff',
      body: { repoId: state.repoId, sha: state.selectedCommit.sha },
    });
  } else if (state.selectedSession) {
    const session = state.sessions.find((s) => s.id === state.selectedSession);
    target.textContent = session ? `Session — ${session.title}` : 'Session selected';
    buttons.push({
      label: 'Summarise session',
      task: 'summarize-session',
      body: { sessionId: state.selectedSession, title: session?.title },
    });
  } else if (state.repo) {
    target.textContent = `${state.repo.name} — ${state.repo.branch || 'detached'}`;
  } else {
    target.textContent = 'No selection';
  }

  if (state.repo) {
    buttons.push({
      label: 'Draft commit message',
      task: 'commit-message',
      body: { repoId: state.repoId },
    });
    buttons.push({
      label: 'Explain current branch',
      task: 'explain-branch',
      body: {
        repoId: state.repoId,
        base: state.repo.base || 'main',
        head: state.repo.branch || 'HEAD',
      },
    });
  }

  for (const button of buttons) {
    actions.appendChild(
      el('button', {
        class: 'btn btn-small',
        text: button.label,
        onclick: () => runAi(button.task, button.body),
      }),
    );
  }

  if (!state.model?.available) {
    actions.appendChild(
      el('span', { class: 'muted', style: 'font-size:11px', text: 'local model unavailable' }),
    );
  }
}

async function runAi(task, body) {
  const output = $('#ai-output');
  const model = selectedModel();
  if (model) body = { ...body, model };
  output.textContent = '';
  output.appendChild(el('div', { class: 'empty', text: 'Thinking… (local model)' }));

  try {
    const result = await api(`/api/ai/${task}`, { method: 'POST', body });
    output.textContent = '';
    output.appendChild(document.createTextNode(result.text || '(no output)'));
    const meta = [];
    if (result.backend) meta.push(`via ${result.backend}`);
    if (result.model) meta.push(result.model);
    if (result.durationMs) meta.push(`${result.durationMs}ms`);
    if (result.tokens) meta.push(`${result.tokens} tokens`);
    if (meta.length) {
      output.appendChild(el('div', { class: 'ai-meta', text: meta.join(' · ') }));
    }
  } catch (err) {
    output.textContent = '';
    output.appendChild(el('div', { class: 'empty', text: err.message }));
  }
}

function switchSideTab(name) {
  for (const tab of document.querySelectorAll('#side-tabs .tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.pane-side .tab-panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
}

/* ------------------------------------------------------------------ */
/* Guarded actions                                                     */
/* ------------------------------------------------------------------ */

/**
 * Ask for a single line of text, then hand it to a guarded action.
 *
 * The value is typed by a person, but it still goes through the same
 * preview-then-confirm path as every other write, so the exact `git` command
 * is always shown before anything runs.
 */
function openTextDialog({ title, note, placeholder, value = '', rows = 4, onSubmit }) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-note').textContent = note || '';
  $('#modal-command').textContent = '';

  const extra = $('#modal-extra');
  extra.textContent = '';

  const input = el('textarea', {
    class: 'commit-input',
    rows: String(rows),
    placeholder: placeholder || '',
  });
  input.value = value;
  extra.appendChild(input);

  modal.hidden = false;

  const confirmBtn = $('#modal-confirm');
  const cancelBtn = $('#modal-cancel');

  const close = () => {
    modal.hidden = true;
    confirmBtn.removeEventListener('click', onConfirm);
    cancelBtn.removeEventListener('click', close);
  };

  const onConfirm = async () => {
    const text = input.value.trim();
    if (!text) {
      toast('A value is required', 'error');
      return;
    }
    close();
    await onSubmit(text);
  };

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', close);
  input.focus();
}

function openCommitDialog() {
  openTextDialog({
    title: 'Commit staged changes',
    note: 'The staged changes will be committed with this message. Nothing is written until you confirm.',
    placeholder: 'feat(scope): what this change does',
    onSubmit: (message) => runAction('commit', { message }),
  });
}

function openBranchDialog() {
  openTextDialog({
    title: 'Create a branch',
    note: 'The new branch starts from the current HEAD. The working tree must be clean.',
    placeholder: 'features/what-this-is-about',
    rows: 1,
    onSubmit: (name) => runAction('branch', { name }),
  });
}

async function runAction(action, args) {
  if (!state.repoId) return;

  let preview;
  try {
    preview = await api(`/api/actions/${action}`, {
      method: 'POST',
      body: { repoId: state.repoId, args, confirm: false },
    });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  openModal(preview, async () => {
    try {
      const result = await api(`/api/actions/${action}`, {
        method: 'POST',
        body: { repoId: state.repoId, args, confirm: true },
      });
      if (result.ok) {
        toast(result.note || 'Done', 'ok');
      } else {
        toast(result.error || 'Action failed', 'error');
      }
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function openModal(preview, onConfirm) {
  const modal = $('#modal');
  $('#modal-title').textContent = preview.label || 'Confirm';
  $('#modal-note').textContent = preview.note || '';
  $('#modal-command').textContent = preview.command;

  const extra = $('#modal-extra');
  extra.textContent = '';

  if (preview.preview?.incomingCommits?.length) {
    const list = el('ul');
    for (const line of preview.preview.incomingCommits) list.appendChild(el('li', { text: line }));
    extra.appendChild(el('div', { text: 'Commits that would come in:' }));
    extra.appendChild(list);
  }
  if (preview.preview?.conflicts?.length) {
    extra.appendChild(el('div', { text: 'Conflicts:', style: 'color:var(--danger)' }));
    const list = el('ul');
    for (const line of preview.preview.conflicts) list.appendChild(el('li', { text: line }));
    extra.appendChild(list);
  }

  modal.hidden = false;

  const confirmBtn = $('#modal-confirm');
  const cancelBtn = $('#modal-cancel');

  const close = () => {
    modal.hidden = true;
    confirmBtn.removeEventListener('click', onConfirmClick);
    cancelBtn.removeEventListener('click', close);
  };
  const onConfirmClick = async () => {
    close();
    await onConfirm();
  };

  confirmBtn.addEventListener('click', onConfirmClick);
  cancelBtn.addEventListener('click', close);
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

async function selectRepo(path) {
  state.repoId = repoId(path);
  state.repo = state.repos.find((r) => r.path === path) || null;
  state.selectedCommit = null;
  state.selectedSession = null;

  renderRepos();
  updateRepoHeader();

  $('#commit-panel').textContent = '';
  $('#commit-panel').appendChild(el('div', { class: 'empty', text: 'Select a commit to see what it changed.' }));

  await Promise.all([loadGraph(), loadBranches()]);
  if (state.activeTab === 'changes') await loadChanges();
  if (state.activeTab === 'commits') await loadCommits();

  updateAiTarget();
  renderSessions();
}

function updateRepoHeader() {
  const repo = state.repo;
  $('#repo-title').textContent = repo ? repo.name : 'No repository selected';

  if (!repo) {
    $('#repo-subtitle').textContent = 'Pick a repository on the left';
    return;
  }

  const bits = [repo.path];
  if (repo.branch) bits.push(`on ${repo.branch}`);
  if (repo.base && repo.base !== repo.branch) bits.push(`base ${repo.base}`);
  if (repo.ahead || repo.behind) bits.push(`${repo.ahead || 0} ahead / ${repo.behind || 0} behind`);
  if (repo.lastCommit) bits.push(repo.lastCommit.subject);
  $('#repo-subtitle').textContent = bits.join(' · ');
}

async function refresh() {
  try {
    const data = await api('/api/overview');
    state.repos = data.repos;
    state.sessions = data.sessions;
    state.model = data.model;
    if (data.aiModel) state.aiModel = data.aiModel;

    renderModelStatus();
    renderRepos();
    renderSessions();

    if (state.repoId) {
      const current = data.repos.find((r) => repoId(r.path) === state.repoId);
      if (current) {
        state.repo = current;
        updateRepoHeader();
      }
    }
    updateAiTarget();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderModelStatus() {
  const chip = $('#model-status');
  const model = state.model;
  if (!model) {
    chip.textContent = 'no model';
    chip.className = 'chip chip-bad';
    return;
  }

  const active = model.active;
  const backend = model.backends ? model.backends[active] : null;

  if (!model.available) {
    chip.textContent = 'no AI backend';
    chip.className = 'chip chip-bad';
    chip.title = backend?.reason || 'no AI backend is available';
    return;
  }

  // The chip says which backend answers, not just which model is configured:
  // an ollama answer never leaves the machine, an opencode answer does not
  // necessarily.
  const label =
    active === 'ollama'
      ? `ollama · ${state.config?.model || 'local model'}`
      : `opencode · ${state.aiModel || 'default model'}`;
  chip.textContent = label;
  chip.className = 'chip chip-ok';
  chip.title =
    active === 'ollama'
      ? 'Answers come from the local model on this machine. Nothing leaves the box.'
      : `Answers come from the opencode service at ${backend?.host || 'the local service'} using its configured provider.`;
}

function wire() {
  // Main tabs
  for (const tab of document.querySelectorAll('#main-tabs .tab')) {
    tab.addEventListener('click', async () => {
      for (const t of document.querySelectorAll('#main-tabs .tab')) {
        t.classList.toggle('is-active', t === tab);
      }
      for (const p of document.querySelectorAll('.pane-main .tab-panel')) {
        p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
      }
      state.activeTab = tab.dataset.tab;
      if (state.activeTab === 'changes') await loadChanges();
      if (state.activeTab === 'branches') await loadBranches();
      if (state.activeTab === 'commits') await loadCommits();
    });
  }

  // Side tabs
  for (const tab of document.querySelectorAll('#side-tabs .tab')) {
    tab.addEventListener('click', () => switchSideTab(tab.dataset.tab));
  }

  $('#repo-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderRepos();
  });

  $('#session-filter').addEventListener('input', (e) => {
    state.sessionFilter = e.target.value;
    renderSessions();
  });

  $('#session-scope').addEventListener('change', (e) => {
    state.sessionScope = e.target.value;
    renderSessions();
  });

  $('#refresh').addEventListener('click', () => refresh());

  // The commit panel can be folded away to give the graph the full width.
  $('#panel-toggle').addEventListener('click', () => {
    const pane = $('.pane-main');
    const collapsed = pane.classList.toggle('is-panel-collapsed');
    $('#panel-toggle').textContent = collapsed ? '›' : '‹';
    if (state.graph) renderGraphView();
  });
  $('#drawer-close').addEventListener('click', () => {
    $('#drawer').hidden = true;
  });

  // Live updates
  const events = new EventSource('/api/events');
  events.addEventListener('repos', async () => {
    await refresh();
    if (state.repoId) {
      await loadGraph();
      if (state.activeTab === 'branches') await loadBranches();
    }
  });
  events.addEventListener('sessions', async () => {
    const data = await api('/api/sessions');
    state.sessions = data.sessions;
    renderSessions();
    renderRepos();
  });
  events.onopen = () => {
    $('#live-indicator').classList.remove('is-off');
  };
  events.onerror = () => {
    $('#live-indicator').classList.add('is-off');
  };
}

async function boot() {
  wire();
  try {
    state.config = await api('/api/config');
  } catch {
    state.config = {};
  }
  await refresh();
  await loadModels();

  if (state.repos.length) {
    await selectRepo(state.repos[0].path);
  }
}

boot();
