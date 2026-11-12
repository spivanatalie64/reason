# Reason

**An AI-native Git client dashboard.** Every repository, every branch, every
agent session — on one board.

GitKraken answers "what is the state of my work" for human development.
Reason answers the same question for agent-driven development, and adds the
part GitKraken has no answer for: *who is doing this work, right now, and does
the diff match what they said they were doing?*

---

## Why

Work on this machine is done by agents. `git` alone cannot tell you:

- Which of the repositories has an agent actively mid-task right now?
- Which branch did that agent create, and what does it actually change versus the base?
- Is the working tree dirty because of your edit, or because an agent left it half-finished?
- What did the agent *say* it was doing, and does its diff match that story?
- Is there a branch ready to review and merge, or is it still hot?

The data to answer those questions already exists on the machine. Reason joins
it up.

| What | Where it comes from |
| --- | --- |
| Repositories, branches, history, diffs | `git`, read through one narrow wrapper |
| Agent sessions, transcripts, models, token use | the opencode session database, read-only |
| AI review and summaries | the local opencode service, or Ollama |

---

## Running it

No install step. No dependencies. Node 22 or newer.

```sh
git clone https://github.com/spivanatalie64/reason.git
cd reason
node server/index.mjs
```

Then open <http://127.0.0.1:4321>.

```sh
npm start          # the same thing
npm run check      # syntax-check every source file
```

### Configuration

Everything is optional. Defaults work on this machine as they are.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REASON_PORT` | `4321` | Port to listen on |
| `REASON_HOST` | `127.0.0.1` | Loopback only, on purpose |
| `REASON_ROOTS` | `~/.ai/.src` | Colon-separated roots to scan for repositories |
| `REASON_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Session database, opened read-only |
| `REASON_AI_BACKEND` | `auto` | `auto`, `ollama`, or `opencode` |
| `REASON_MODEL` | `qwen2.5-coder:7b` | Model to use for the Ollama backend |

A config file at `~/.config/reason/config.json` is read if it exists and uses
the same keys in JSON form.

---

## What is on the board

**Repositories** — every Git repository under the configured roots, with the
current branch, ahead/behind against the base or the upstream, dirty file
count, stash count, and how many agents have touched it.

**Graph** — the commit history of the selected repository as a routed SVG DAG.
Columns are computed from the commit graph rather than parsed out of
`git log --graph`, because the ASCII form throws away lane identity across
merges and there is no way to colour or hover an individual edge without it.
Click any commit for its metadata and its diff.

**Changes** — the working tree, staged and unstaged together, with the
actions to stage, stash, draft a message, or commit.

**Branches** — local branches with their subjects, and merge actions that
preview the incoming commits and detect conflicts before anything happens.

**Agents** — every session in the opencode database, attributed to the
repository it was working in, with its state, agent, model, token use and
last activity. Sessions whose repository has uncommitted changes are flagged.
Click one to read the transcript.

**AI** — the "Ultra" panel. It reasons over whatever is selected:

- *Summarise session* — what the agent actually did, in plain language
- *Review change* — intent, correctness, risk, and what a reviewer would ask for
- *Draft commit message* — a conventional-commit message from the staged diff
- *Explain branch* — what the branch is for and whether it is ready to merge

---

## The AI backends

Two, and the panel uses whichever answers.

**Ollama** — a model on this machine. Nothing leaves the box. This is the
preferred backend.

**The opencode service** — the same agent runtime this machine's AI work
already uses, so the panel reasons with the same models the agents do. The
service is discovered through `opencode service status`; the port is not
fixed.

Under `auto`, Ollama is tried first and the opencode service is the fallback.
A backend that fails is marked unhealthy for 45 seconds so the panel does not
pay the timeout on every request. The status chip in the header names the
backend that will actually answer, and every AI response says which one
produced it.

> **Note on this machine.** The Ollama client is installed and both models are
> pulled (5.9 GB under `~/.ollama/models`), but the runtime library is not:
> `llama-server` is missing from `~/.local/lib/ollama/`, so every generation
> fails with `llama-server binary not found`. Until that is repaired, the
> panel answers through the opencode service. To repair it, re-run the
> installer with the same install directory it used before:
>
> ```sh
> curl -fsSL https://ollama.com/install.sh | sh
> ```
>
> The models are untouched by this and do not need re-pulling.

### Choosing a model

The model picker in the AI panel lists the models this machine has actually
used, with the number of sessions behind each one. The default is the model
the most recent agent session used, which is guaranteed to be a provider and
model combination that works here.

---

## Safety

The board is read-only by default, and every write is guarded.

- No browser-supplied string ever becomes a Git argument. Each action validates
  its inputs against what the repository actually contains, then builds a
  fixed argument array. Nothing goes through a shell.
- Every action is previewed first. The preview is produced by running the same
  code path with `confirm: false`, so what is shown is exactly what would run:
  the literal `git` command, the commits a merge would bring in, and any
  conflicts, detected with `git merge-tree` without touching the working tree.
- The action set is an allow-list: stage, unstage, commit, branch, checkout,
  merge, cherry-pick, stash, stash pop. There is no path where a request can
  construct a free-form Git command line.
- An action refuses to run if the repository is mid-merge, mid-cherry-pick or
  mid-rebase.
- The session database is opened read-only. Reason never writes to it.

Push and pull are not implemented. The board shows what is there; it does not
talk to your remotes.

---

## Layout

```
server/
  index.mjs      HTTP server, JSON API, static files, server-sent events
  git.mjs        All Git access, in one place
  sessions.mjs   Read-only access to the opencode session database
  ai.mjs         The AI backends and the panel's prompts
  actions.mjs    The guarded write actions
  config.mjs     Configuration and defaults
web/
  index.html     The board
  app.js         The application
  graph.js       Commit graph layout and SVG rendering
  style.css      The dark theme
```

Node's built-in `node:sqlite`, `node:http` and `fetch` cover everything. No
`npm install` to run it, nothing to audit, nothing to break on an update.

---

## The API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/overview` | Repositories, sessions, backend status |
| `GET` | `/api/repos` | Repository list with status |
| `GET` | `/api/repos/:id/graph` | Commit history for the graph |
| `GET` | `/api/repos/:id/commit/:sha` | Commit detail and diff |
| `GET` | `/api/repos/:id/diff?base=&head=` | Diff between two refs |
| `GET` | `/api/repos/:id/worktree` | Working tree state and diff |
| `GET` | `/api/repos/:id/branches` | Local branches |
| `GET` | `/api/sessions` | Agent sessions |
| `GET` | `/api/sessions/:id` | Session transcript |
| `GET` | `/api/models` | Models this machine has used |
| `POST` | `/api/ai/:task` | `summarize-session`, `review-diff`, `commit-message`, `explain-branch` |
| `POST` | `/api/actions/:action` | Preview or run a guarded action |
| `GET` | `/api/events` | Server-sent events for live updates |

Repository ids are the base64url-encoded absolute path, so an id only ever
resolves to a repository that was actually discovered on this machine.

---

## Known gaps

- Push and pull are not implemented.
- Rebase is not implemented.
- The board binds to loopback and has no authentication. That is deliberate:
  it is a tool for one person on one machine. Do not expose it.
- Repository discovery finds nested repositories too — submodules and vendored
  clones appear as their own entries.

---

## License

GPL-3.0-or-later, matching the tooling it sits alongside.
