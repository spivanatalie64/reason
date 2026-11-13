//! Git access.
//!
//! Every Git operation goes through this module. Commands are built as fixed
//! argument arrays and run without a shell, so no value can be interpreted as
//! shell syntax. The only variable parts are values validated against
//! repository state (a commit SHA, a branch that exists, a path inside the
//! repo).

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct GitResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_git(args: &[&str], cwd: &Path) -> GitResult {
    // GIT_OPTIONAL_LOCKS=0: reading state must not contend with a real git
    // operation that might be running in the same repository.
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output();

    match output {
        Ok(out) => GitResult {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
        },
        Err(e) => GitResult {
            code: -1,
            stdout: String::new(),
            stderr: e.to_string(),
        },
    }
}

pub fn git_out(args: &[&str], cwd: &Path) -> Result<String, String> {
    let res = run_git(args, cwd);
    if res.code == 0 {
        Ok(res.stdout)
    } else {
        Err(if res.stderr.trim().is_empty() {
            format!("git {} failed with code {}", args.first().unwrap_or(&"?"), res.code)
        } else {
            res.stderr.trim().to_string()
        })
    }
}

/// Discover Git repositories under a set of roots.
///
/// A directory containing `.git` is a repository, but the walk continues past
/// it: a container directory can itself be an initialised repository while
/// holding the real repositories inside it.
pub fn discover_repos(roots: &[PathBuf], skip_dirs: &HashSet<String>) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();

    fn walk(
        dir: &Path,
        depth: usize,
        skip: &HashSet<String>,
        found: &mut Vec<PathBuf>,
        seen: &mut HashSet<PathBuf>,
        visited: &mut usize,
    ) {
        if depth > 8 || *visited > 60000 {
            return;
        }
        *visited += 1;
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let entries: Vec<_> = entries.flatten().collect();

        if entries.iter().any(|e| e.file_name() == ".git") {
            let real = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
            if seen.insert(real.clone()) {
                found.push(real);
            }
        }

        for entry in entries {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }
            if skip.contains(&name_str.to_lowercase()) {
                continue;
            }
            walk(&entry.path(), depth + 1, skip, found, seen, visited);
        }
    }

    let mut visited = 0usize;
    for root in roots {
        if root.is_dir() {
            walk(root, 0, skip_dirs, &mut found, &mut seen, &mut visited);
        }
    }
    found.sort();
    found
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub base: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<i32>,
    pub behind: Option<i32>,
    pub detached: bool,
    pub dirty_files: usize,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub stashes: usize,
    pub last_commit: Option<LastCommit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LastCommit {
    pub sha: String,
    pub author: String,
    pub at: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Branch {
    pub name: String,
    pub sha: String,
    pub upstream: Option<String>,
    pub at: i64,
    pub subject: String,
    pub current: bool,
}

fn split_nul_records(text: &str) -> Vec<&str> {
    text.split('\0').filter(|s| !s.is_empty()).collect()
}

fn split_unit_fields(record: &str) -> Vec<String> {
    let mut parts: Vec<String> = record.split('\x1f').map(|s| s.to_string()).collect();
    if parts.last().map(|s| s.is_empty()).unwrap_or(false) {
        parts.pop();
    }
    parts
}

#[derive(Debug, Clone)]
pub struct StatusEntry {
    pub code: String,
    pub file: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

pub fn parse_status(text: &str) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let fields: Vec<&str> = text.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let raw = fields[i];
        i += 1;
        if raw.is_empty() {
            continue;
        }
        let code = if raw.len() >= 2 { &raw[0..2] } else { raw };
        let file = if raw.len() > 3 { raw[3..].to_string() } else { String::new() };
        let mut e = StatusEntry {
            code: code.to_string(),
            file,
            staged: false,
            unstaged: false,
            untracked: code == "??",
        };
        if code != "??" {
            let bytes = code.as_bytes();
            e.staged = bytes.first().map(|b| *b != b' ' && *b != b'?').unwrap_or(false);
            e.unstaged = bytes.get(1).map(|b| *b != b' ' && *b != b'?').unwrap_or(false);
        }
        // Renames/copies include the original path as the next NUL field.
        if code.starts_with('R') || code.starts_with('C') {
            i += 1;
        }
        entries.push(e);
    }
    entries
}

pub fn branch_list(repo: &Path) -> Vec<Branch> {
    let raw = git_out(
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(committerdate:unix)%00%(subject)%00%(HEAD)",
            "refs/heads",
        ],
        repo,
    )
    .unwrap_or_default();

    raw.lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\0').collect();
            let get = |i: usize| parts.get(i).map(|s| s.to_string()).unwrap_or_default();
            Branch {
                name: get(0),
                sha: get(1),
                upstream: {
                    let u = get(2);
                    if u.is_empty() { None } else { Some(u) }
                },
                at: get(3).parse().unwrap_or(0),
                subject: get(4),
                current: get(5) == "*",
            }
        })
        .collect()
}

pub fn ahead_behind(repo: &Path, base: &str, head: &str) -> (Option<i32>, Option<i32>) {
    let range = format!("{base}...{head}");
    let res = run_git(&["rev-list", "--left-right", "--count", &range], repo);
    if res.code != 0 {
        return (None, None);
    }
    let nums: Vec<i32> = res
        .stdout
        .trim()
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
    // left = commits in base not in head (behind), right = ahead
    (nums.get(1).copied(), nums.get(0).copied())
}

pub fn repo_info(repo: &Path, base_branches: &[String]) -> Option<RepoInfo> {
    let branch_res = run_git(&["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
    let branch = if branch_res.code == 0 {
        let b = branch_res.stdout.trim().to_string();
        if b.is_empty() { None } else { Some(b) }
    } else {
        None
    };

    let head_res = run_git(&["rev-parse", "HEAD"], repo);
    let head = if head_res.code == 0 {
        let h = head_res.stdout.trim().to_string();
        if h.is_empty() { None } else { Some(h) }
    } else {
        None
    };

    // A commitless repository is an empty shell.
    let head = head?;

    let status_res = run_git(
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        repo,
    );
    let status = parse_status(&status_res.stdout);
    let dirty_files = status.len();
    let staged = status.iter().filter(|s| s.staged).count();
    let unstaged = status.iter().filter(|s| s.unstaged).count();
    let untracked = status.iter().filter(|s| s.untracked).count();

    let stash_res = run_git(&["stash", "list"], repo);
    let stashes = stash_res
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .count();

    let last_res = run_git(&["log", "-1", "--format=%H%x1f%an%x1f%at%x1f%s"], repo);
    let last_commit = if last_res.code == 0 {
        let f = split_unit_fields(last_res.stdout.trim());
        Some(LastCommit {
            sha: f.first().cloned().unwrap_or_default(),
            author: f.get(1).cloned().unwrap_or_default(),
            at: f.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
            subject: f.get(3).cloned().unwrap_or_default(),
        })
    } else {
        None
    };

    let branches = branch_list(repo);
    let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    let base = base_branches
        .iter()
        .find(|b| names.iter().any(|n| n == b))
        .cloned();

    let mut ahead = None;
    let mut behind = None;
    let mut upstream = None;

    if let Some(ref br) = branch {
        if let Some(current) = branches.iter().find(|b| &b.name == br) {
            upstream = current.upstream.clone();
            if let Some(ref up) = current.upstream {
                let (a, b) = ahead_behind(repo, up, br);
                ahead = a;
                behind = b;
            } else if let Some(ref base_name) = base {
                if base_name != br {
                    let (a, b) = ahead_behind(repo, base_name, br);
                    ahead = a;
                    behind = b;
                }
            }
        }
    }

    Some(RepoInfo {
        name: repo
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| repo.to_string_lossy().to_string()),
        path: repo.to_string_lossy().to_string(),
        detached: branch.is_none(),
        branch,
        head: Some(head),
        base,
        upstream,
        ahead,
        behind,
        dirty_files,
        staged,
        unstaged,
        untracked,
        stashes,
        last_commit,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub at: i64,
    pub subject: String,
    pub body: String,
    pub refs: Vec<RefLabel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RefLabel {
    pub full: String,
    pub short: String,
    pub remote: bool,
}

pub fn ref_map(repo: &Path) -> HashMap<String, Vec<RefLabel>> {
    let raw = git_out(
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
        repo,
    )
    .unwrap_or_default();

    let mut map: HashMap<String, Vec<RefLabel>> = HashMap::new();
    for line in raw.lines().filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 3 {
            continue;
        }
        let full = parts[0].to_string();
        let sha = parts[1].to_string();
        let short = parts[2].to_string();
        map.entry(sha).or_default().push(RefLabel {
            remote: full.starts_with("refs/remotes/"),
            full,
            short,
        });
    }
    map
}

pub fn commit_log(repo: &Path, limit: usize) -> Vec<Commit> {
    let format = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cI%x1f%D%x1f%s%x1f%b";
    let max = format!("--max-count={limit}");
    let raw = git_out(&["log", "--all", "--topo-order", "-z", &max, &format!("--format={format}")], repo)
        .unwrap_or_default();

    let refs = ref_map(repo);
    split_nul_records(&raw)
        .into_iter()
        .map(|record| {
            let f = split_unit_fields(record);
            let sha = f.first().cloned().unwrap_or_default();
            let parents = f
                .get(1)
                .map(|p| p.split_whitespace().map(|s| s.to_string()).collect())
                .unwrap_or_default();
            Commit {
                refs: refs.get(&sha).cloned().unwrap_or_default(),
                sha,
                parents,
                author: f.get(2).cloned().unwrap_or_default(),
                email: f.get(3).cloned().unwrap_or_default(),
                at: f.get(4).and_then(|s| s.parse().ok()).unwrap_or(0),
                subject: f.get(7).cloned().unwrap_or_default(),
                body: f.get(8).cloned().unwrap_or_default().trim().to_string(),
            }
        })
        .collect()
}

pub fn commit_diff(repo: &Path, sha: &str) -> Result<String, String> {
    if !sha.chars().all(|c| c.is_ascii_hexdigit()) || sha.len() < 7 {
        return Err("not a commit sha".to_string());
    }
    git_out(&["show", "--format=", "--no-color", sha], repo)
}

pub fn worktree_diff(repo: &Path) -> Result<String, String> {
    git_out(&["diff", "--no-color", "HEAD"], repo)
}
