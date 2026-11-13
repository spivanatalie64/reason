# Reason

**An AI-native Git client dashboard — a GTK C+Rust desktop application.** Every
repository, every branch, every agent session — in one native window.

GitKraken answers "what is the state of my work" for human development.
Reason answers the same question for agent-driven development, and adds the
part GitKraken has no answer for: *who is doing this work, right now, and does
the diff match what they said they were doing?*

---

## Why

Work on this machine is done by agents. `git` alone cannot tell you:

- Which repository has an agent actively mid-task right now?
- Which branch did that agent create, and what does it actually change versus the base?
- Is the working tree dirty because of your edit, or because an agent left it half-finished?
- What did the agent *say* it was doing, and does its diff match that story?
- Is there a branch ready to review and merge, or is it still hot?

The data to answer those questions already exists on the machine. Reason joins
it up.

| What | Where it comes from |
| --- | --- |
| Repositories, branches, history, diffs | `git`, read through one narrow wrapper (fixed argv, no shell) |
| Agent sessions, transcripts, models, token use | the opencode session database, opened read-only |
| AI review and summaries | the local opencode service, or Ollama (local backends only) |

---

## Building and running

Native GTK4 application. No browser, no web server.

### Requirements

- Rust toolchain (`cargo`, `rustc`)
- A C compiler (`gcc`/`cc`)
- GTK4 development libraries (`gtk4`, pkg-config)
- SQLite is bundled via `rusqlite` (`bundled` feature) — no system libsqlite required to build

```sh
cargo build --release
cargo run
```

The binary launches the Reason window directly.

### Configuration

Defaults work on this machine without setup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REASON_ROOTS` | `~/.ai/.src` | Colon-separated roots to scan for repositories |
| `REASON_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | Session database, opened read-only |
| `REASON_AI_BACKEND` | `auto` | `auto`, `ollama`, or `opencode` |
| `REASON_MODEL` | `qwen2.5-coder:7b` | Model for the Ollama backend |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |

A config file at `~/.config/reason/config.json` is read if it exists.

---

## Architecture

Rust primary, C where it earns its keep (graph layout and diff helpers), linked
into one native binary.

| Module | Responsibility |
| --- | --- |
| `src/main.rs` | GTK4 application, window, and UI |
| `src/git.rs` | All Git access — fixed argument arrays, no shell |
| `src/sessions.rs` | Read-only opencode SQLite session reader |
| `src/ai.rs` | Local AI backends (opencode service / Ollama) |
| `src/actions.rs` | Guarded mutations: preview, then explicit confirm |
| `src/graph.rs` + `src/c/graph_layout.c` | DAG lane assignment (C) and graph model (Rust) |
| `src/config.rs` | Configuration and defaults |

The lane layout is computed in C over plain arrays so the hot path stays small
and the algorithm is testable without GTK.

---

## Safety

- The session database is opened **read-only**. Reason never writes to it.
- No user-controlled string becomes a Git argument. Every operation validates
  inputs against repository state and runs a fixed argv — no shell.
- Mutations are **guarded**: stage, unstage, commit, branch, checkout, merge,
  cherry-pick, stash, stash pop are allow-listed, previewed (exact command,
  incoming commits, `git merge-tree` conflict detection) and run only on
  explicit confirmation.
- AI stays local. Prompts, diffs and transcripts are sent only to local
  backends.

Push/pull and rebase are out of scope for v1.

---

## Status

Active development on `features/gtk-native` (tracked in
[issue #1](https://github.com/spivanatalie64/reason/issues/1)). The application
compiles (`cargo check` clean of errors) and provides the GTK4 shell with
repository discovery, commit history with DAG lane layout, and the agent session
feed. Diff viewer, AI panel UI, and the full guarded-action dialogs are being
wired into the native interface.

## License

GPL-3.0-or-later.
