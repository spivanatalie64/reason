//! Read-only access to the opencode session database.
//!
//! The database records what agents actually did. Reason reads it but never
//! writes to it — opening read-only is enforced at the SQLite level.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub directory: String,
    pub agent: Option<String>,
    pub model_id: Option<String>,
    pub model_provider: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub busy_at: Option<i64>,
    pub idle_at: Option<i64>,
    pub idle_outcome: Option<String>,
    pub state: String,
    pub cost: f64,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_reasoning: i64,
    pub repo_path: Option<String>,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptMessage {
    pub id: String,
    pub r#type: String,
    pub seq: i64,
    pub at: i64,
    pub text: String,
    pub agent: Option<String>,
}

pub fn open_db(path: &Path) -> Option<Connection> {
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn resolve_scope(directory: &str, repo_paths: &[String]) -> (String, Option<String>) {
    let dir = directory.trim_end_matches('/');
    // Longest matching repo prefix wins.
    let mut best: Option<&String> = None;
    for repo in repo_paths {
        let r = repo.trim_end_matches('/');
        if dir == r || dir.starts_with(&format!("{r}/")) {
            if best.map(|b| r.len() > b.len()).unwrap_or(true) {
                best = Some(repo);
            }
        }
    }
    if let Some(b) = best {
        return ("repo".to_string(), Some(b.clone()));
    }
    // Session dir contains repos but is not one.
    let prefix = format!("{dir}/");
    if repo_paths.iter().any(|r| r.starts_with(&prefix)) {
        return ("workspace".to_string(), None);
    }
    ("none".to_string(), None)
}

fn parse_model(json: Option<String>) -> (Option<String>, Option<String>) {
    let Some(j) = json else { return (None, None) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&j) else {
        return (None, None);
    };
    let id = v.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
    let provider = v
        .get("providerID")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    (id, provider)
}

fn derive_state(busy: Option<i64>, idle: Option<i64>, outcome: &Option<String>) -> String {
    let b = busy.unwrap_or(0);
    let i = idle.unwrap_or(0);
    if b > i {
        "running".to_string()
    } else if let Some(o) = outcome {
        if o == "succeeded" { "done".to_string() } else { "stopped".to_string() }
    } else if busy.is_some() {
        "idle".to_string()
    } else {
        "stale".to_string()
    }
}

pub fn list_sessions(path: &Path, repo_paths: &[String]) -> Vec<Session> {
    let Some(conn) = open_db(path) else {
        return Vec::new();
    };
    let sql = "SELECT id, title, directory, agent, model,
                      time_created, time_updated, time_idle, time_busy, idle_outcome,
                      cost, tokens_input, tokens_output, tokens_reasoning
               FROM session_v2 ORDER BY time_updated DESC";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        let directory: String = row.get(2)?;
        let busy: Option<i64> = row.get(8)?;
        let idle: Option<i64> = row.get(7)?;
        let outcome: Option<String> = row.get(9)?;
        let model_json: Option<String> = row.get(4)?;
        let (model_id, model_provider) = parse_model(model_json);
        let (scope, repo_path) = resolve_scope(&directory, repo_paths);
        Ok(Session {
            id: row.get(0)?,
            title: row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "(untitled session)".into()),
            directory,
            agent: row.get(3)?,
            model_id,
            model_provider,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            busy_at: busy,
            idle_at: idle,
            idle_outcome: outcome.clone(),
            state: derive_state(busy, idle, &outcome),
            cost: row.get::<_, Option<f64>>(10)?.unwrap_or(0.0),
            tokens_input: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
            tokens_output: row.get::<_, Option<i64>>(12)?.unwrap_or(0),
            tokens_reasoning: row.get::<_, Option<i64>>(13)?.unwrap_or(0),
            repo_path,
            scope,
        })
    });
    match rows {
        Ok(mapped) => mapped.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// Extract readable text from a message data blob.
pub fn message_text(data: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return String::new();
    };
    if let Some(t) = v.get("text").and_then(|x| x.as_str()) {
        let t = t.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Some(parts) = v.get("content").and_then(|x| x.as_array()) {
        let mut out = Vec::new();
        for p in parts {
            if p.get("type").and_then(|x| x.as_str()) == Some("text") {
                if let Some(t) = p.get("text").and_then(|x| x.as_str()) {
                    if !t.trim().is_empty() {
                        out.push(t.to_string());
                    }
                }
            }
        }
        if !out.is_empty() {
            return out.join("\n\n");
        }
    }
    if let Some(t) = v.get("content").and_then(|x| x.as_str()) {
        return t.trim().to_string();
    }
    String::new()
}

pub fn transcript(path: &Path, session_id: &str) -> Vec<TranscriptMessage> {
    let Some(conn) = open_db(path) else {
        return Vec::new();
    };
    let sql = "SELECT id, type, seq, time_created, data
               FROM session_message
               WHERE session_id = ?1 AND type IN ('user','assistant','system','synthetic')
               ORDER BY seq ASC";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([session_id], |row| {
        let data: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
        let text = message_text(&data);
        let parsed: serde_json::Value = serde_json::from_str(&data).unwrap_or(serde_json::Value::Null);
        let agent = parsed.get("agent").and_then(|x| x.as_str()).map(|s| s.to_string());
        Ok(TranscriptMessage {
            id: row.get(0)?,
            r#type: row.get(1)?,
            seq: row.get(2)?,
            at: row.get(3)?,
            text,
            agent,
        })
    });
    match rows {
        Ok(mapped) => mapped.flatten().filter(|m| !m.text.is_empty() || m.r#type == "system").collect(),
        Err(_) => Vec::new(),
    }
}
