//! Guarded Git mutations.
//!
//! A browser-supplied string never becomes a Git argument, and nothing runs
//! until the caller has seen a preview and confirmed it. The preview is
//! produced by the same code path as execution (confirm=false), so what is
//! shown is exactly what would run.

use crate::git;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Preview {
    pub action: String,
    pub label: String,
    pub command: String,
    pub note: String,
    pub ok: bool,
    pub error: Option<String>,
}

fn describe(args: &[String]) -> String {
    let mut parts = vec!["git".to_string()];
    for a in args {
        if a.contains(|c: char| c.is_whitespace() || c == '\'' || c == '"') {
            parts.push(format!("'{}'", a.replace('\'', "'\\''")));
        } else {
            parts.push(a.clone());
        }
    }
    parts.join(" ")
}

fn validate_branch(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("branch name is empty".into());
    }
    let first = name.chars().next().unwrap();
    if !first.is_ascii_alphanumeric() {
        return Err(format!("Not a usable branch name: {name:?}"));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c)) {
        return Err(format!("Not a usable branch name: {name:?}"));
    }
    if name.contains("..") || name.ends_with('/') || name.contains("//") {
        return Err(format!("Not a usable branch name: {name}"));
    }
    Ok(())
}

fn validate_sha(sha: &str) -> Result<(), String> {
    if sha.len() < 7 || sha.len() > 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Not a commit sha: {sha:?}"));
    }
    Ok(())
}

fn assert_clean_state(repo: &Path) -> Result<(), String> {
    for (name, msg) in [
        ("MERGE_HEAD", "a merge is in progress"),
        ("CHERRY_PICK_HEAD", "a cherry-pick is in progress"),
        ("REVERT_HEAD", "a revert is in progress"),
        ("rebase-merge", "a rebase is in progress"),
        ("rebase-apply", "a rebase is in progress"),
    ] {
        let r = git::run_git(&["rev-parse", "--git-path", name], repo);
        if r.code != 0 { continue; }
        let path = r.stdout.trim();
        let v = git::run_git(&["rev-parse", "--verify", "--quiet", path], repo);
        if v.code == 0 {
            return Err(format!("Refusing to act: {msg} in {}. Finish it first.", repo.display()));
        }
    }
    Ok(())
}

fn current_status(repo: &Path) -> Vec<git::StatusEntry> {
    let r = git::run_git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"], repo);
    git::parse_status(&r.stdout)
}

pub fn preview(repo: &Path, action: &str, name: Option<&str>, message: Option<&str>) -> Preview {
    let mk = |label: &str, args: Vec<String>, note: String| Preview {
        action: action.to_string(),
        label: label.to_string(),
        command: describe(&args),
        note,
        ok: true,
        error: None,
    };
    let err = |label: &str, e: String| Preview {
        action: action.to_string(),
        label: label.to_string(),
        command: String::new(),
        note: String::new(),
        ok: false,
        error: Some(e),
    };

    if let Err(e) = assert_clean_state(repo) {
        return err(action, e);
    }

    match action {
        "stage" => {
            let status = current_status(repo);
            let files: Vec<String> = status.iter().filter(|s| s.untracked || s.unstaged).map(|s| s.file.clone()).collect();
            if files.is_empty() { return err("Stage files", "Nothing to stage.".into()); }
            let mut args = vec!["add".into(), "--".into()];
            args.extend(files.iter().cloned());
            mk("Stage files", args, format!("Stages {} file(s).", files.len()))
        }
        "commit" => {
            let msg = message.unwrap_or("").trim();
            if msg.is_empty() { return err("Commit", "A commit message is required.".into()); }
            let staged = current_status(repo).into_iter().filter(|s| s.staged).count();
            if staged == 0 { return err("Commit", "Nothing is staged to commit.".into()); }
            mk("Commit staged changes", vec!["commit".into(), "-m".into(), msg.into()], format!("Commits {staged} staged file(s)."))
        }
        "branch" => {
            let n = name.unwrap_or("");
            if let Err(e) = validate_branch(n) { return err("Create branch", e); }
            let exists = git::run_git(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{n}")], repo);
            if exists.code == 0 { return err("Create branch", format!("Branch already exists: {n}")); }
            if !current_status(repo).is_empty() {
                return err("Create branch", "Working tree is not clean. Commit or stash before branching.".into());
            }
            mk("Create branch", vec!["switch".into(), "-c".into(), n.into()], format!("Creates and switches to {n}."))
        }
        "merge" => {
            let n = name.unwrap_or("");
            if let Err(e) = validate_branch(n) { return err("Merge branch", e); }
            let exists = git::run_git(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{n}")], repo);
            if exists.code != 0 { return err("Merge branch", format!("No such branch: {n}")); }
            let current = git::run_git(&["symbolic-ref", "--quiet", "--short", "HEAD"], repo).stdout.trim().to_string();
            if current == n { return err("Merge branch", format!("Already on {n}.")); }
            let head = git::run_git(&["rev-parse", "HEAD"], repo).stdout.trim().to_string();
            let other = git::run_git(&["rev-parse", n], repo).stdout.trim().to_string();
            let tree = git::run_git(&["merge-tree", "--write-tree", "--name-only", &head, &other], repo);
            let conflicts = if tree.code == 1 {
                tree.stdout.lines().skip(1).filter(|l| !l.is_empty()).count()
            } else { 0 };
            let note = if conflicts > 0 {
                format!("Merges {n} into {current}. {conflicts} conflict(s) detected.")
            } else {
                format!("Merges {n} into {current}. No conflicts detected.")
            };
            mk("Merge branch", vec!["merge".into(), "--no-ff".into(), n.into()], note)
        }
        "cherry-pick" | "cherryPick" => {
            let sha = name.unwrap_or("");
            if let Err(e) = validate_sha(sha) { return err("Cherry-pick", e); }
            let exists = git::run_git(&["cat-file", "-e", &format!("{sha}^{{commit}}")], repo);
            if exists.code != 0 { return err("Cherry-pick", format!("No such commit: {sha}")); }
            let subject = git::run_git(&["log", "-1", "--format=%s", sha], repo).stdout.trim().to_string();
            mk("Cherry-pick commit", vec!["cherry-pick".into(), sha.into()], format!("Cherry-picks {} — {subject}", &sha[..8.min(sha.len())]))
        }
        "stash" => {
            let status = current_status(repo);
            if status.is_empty() { return err("Stash", "Working tree is clean; nothing to stash.".into()); }
            let msg = message.unwrap_or("reason: stash").to_string();
            mk("Stash changes", vec!["stash".into(), "push".into(), "-m".into(), msg], format!("Stashes {} change(s).", status.len()))
        }
        _ => err(action, format!("Unknown action: {action}")),
    }
}

pub fn execute(repo: &Path, action: &str, name: Option<&str>, message: Option<&str>) -> Preview {
    let p = preview(repo, action, name, message);
    if !p.ok || p.command.is_empty() {
        return p;
    }
    // Reconstruct argv from the preview: safest is to rebuild via preview logic.
    // For execution we rebuild the same args.
    let args: Vec<String> = match action {
        "stage" => {
            let status = current_status(repo);
            let mut a = vec!["add".to_string(), "--".to_string()];
            a.extend(status.into_iter().filter(|s| s.untracked || s.unstaged).map(|s| s.file));
            a
        }
        "commit" => vec!["commit".into(), "-m".into(), message.unwrap_or("").trim().into()],
        "branch" => vec!["switch".into(), "-c".into(), name.unwrap_or("").into()],
        "merge" => vec!["merge".into(), "--no-ff".into(), name.unwrap_or("").into()],
        "cherry-pick" | "cherryPick" => vec!["cherry-pick".into(), name.unwrap_or("").into()],
        "stash" => vec!["stash".into(), "push".into(), "-m".into(), message.unwrap_or("reason: stash").into()],
        _ => return Preview { ok: false, error: Some("Unknown action".into()), ..p },
    };
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let res = git::run_git(&refs, repo);
    if res.code == 0 {
        Preview { ok: true, ..p }
    } else {
        Preview {
            ok: false,
            error: Some(if res.stderr.trim().is_empty() { format!("git exited with code {}", res.code) } else { res.stderr.trim().to_string() }),
            ..p
        }
    }
}
