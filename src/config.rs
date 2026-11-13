//! Configuration for Reason.
//!
//! Defaults are chosen to work on this machine without setup. A config file at
//! `~/.config/reason/config.json` is read if it exists; environment variables
//! override it. No setting is required.

use serde::Deserialize;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub roots: Vec<PathBuf>,
    pub opencode_db: PathBuf,
    pub base_branches: Vec<String>,
    pub poll_ms: u64,
    pub max_commits: usize,
    pub skip_dirs: HashSet<String>,
    pub ollama_host: String,
    pub ollama_model: String,
    pub ai_backend: String, // auto | ollama | opencode
    pub opencode_host: Option<String>,
    pub opencode_password_file: PathBuf,
}

#[derive(Debug, Deserialize, Default)]
struct FileConfig {
    roots: Option<Vec<String>>,
    opencode_db: Option<String>,
    #[serde(rename = "opencodeDb")]
    opencode_db_camel: Option<String>,
    base_branches: Option<Vec<String>>,
    #[serde(rename = "baseBranches")]
    base_branches_camel: Option<Vec<String>>,
    poll_ms: Option<u64>,
    #[serde(rename = "pollMs")]
    poll_ms_camel: Option<u64>,
    max_commits: Option<usize>,
    #[serde(rename = "maxCommits")]
    max_commits_camel: Option<usize>,
    ollama: Option<OllamaFile>,
    ai: Option<AiFile>,
    #[serde(rename = "opencodeHost")]
    opencode_host: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OllamaFile {
    host: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct AiFile {
    backend: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        let home = dirs_home();
        let mut skip = HashSet::new();
        for d in [
            "node_modules",
            ".venv",
            "venv",
            "target",
            "dist",
            "build",
            ".git",
        ] {
            skip.insert(d.to_string());
        }
        Self {
            roots: vec![home.join(".ai/.src")],
            opencode_db: home.join(".local/share/opencode/opencode.db"),
            base_branches: ["main", "master", "develop", "trunk"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            poll_ms: 4000,
            max_commits: 400,
            skip_dirs: skip,
            ollama_host: "http://127.0.0.1:11434".to_string(),
            ollama_model: "qwen2.5-coder:7b".to_string(),
            ai_backend: "auto".to_string(),
            opencode_host: None,
            opencode_password_file: home.join(".config/opencode/service.json"),
        }
    }
}

pub fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home/natalie"))
}

fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("REASON_CONFIG") {
        return PathBuf::from(p);
    }
    dirs_home().join(".config/reason/config.json")
}

fn read_file() -> FileConfig {
    let path = config_path();
    let Ok(data) = std::fs::read_to_string(path) else {
        return FileConfig::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

pub fn load() -> Config {
    let mut cfg = Config::default();
    let file = read_file();

    if let Ok(v) = std::env::var("REASON_ROOTS") {
        cfg.roots = v.split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect();
    } else if let Some(r) = file.roots {
        cfg.roots = r.into_iter().map(PathBuf::from).collect();
    }

    if let Ok(v) = std::env::var("REASON_OPENCODE_DB") {
        cfg.opencode_db = PathBuf::from(v);
    } else if let Some(p) = file.opencode_db.or(file.opencode_db_camel) {
        cfg.opencode_db = PathBuf::from(p);
    }

    if let Some(b) = file.base_branches.or(file.base_branches_camel) {
        cfg.base_branches = b;
    }
    if let Some(ms) = file.poll_ms.or(file.poll_ms_camel) {
        cfg.poll_ms = ms;
    }
    if let Some(n) = file.max_commits.or(file.max_commits_camel) {
        cfg.max_commits = n;
    }

    if let Some(o) = file.ollama {
        if let Some(h) = o.host { cfg.ollama_host = h; }
        if let Some(m) = o.model { cfg.ollama_model = m; }
    }
    if let Ok(v) = std::env::var("OLLAMA_HOST") { cfg.ollama_host = v; }
    if let Ok(v) = std::env::var("REASON_MODEL") { cfg.ollama_model = v; }

    if let Some(ai) = file.ai {
        if let Some(b) = ai.backend { cfg.ai_backend = b; }
    }
    if let Ok(v) = std::env::var("REASON_AI_BACKEND") { cfg.ai_backend = v; }

    if let Ok(v) = std::env::var("REASON_OPENCODE_HOST") {
        cfg.opencode_host = Some(v);
    } else if let Some(h) = file.opencode_host {
        cfg.opencode_host = Some(h);
    }

    if let Ok(v) = std::env::var("REASON_OPENCODE_PASSWORD_FILE") {
        cfg.opencode_password_file = PathBuf::from(v);
    }

    cfg
}
