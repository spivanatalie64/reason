//! AI panel backends.
//!
//! Two backends, in order of preference:
//!   1. Ollama — a model on this machine. Nothing leaves the box.
//!   2. The local opencode service — the agent runtime already on this machine.
//!
//! The backend that actually answered is reported with every response.

use crate::config::Config;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::json;
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct AiResult {
    pub text: String,
    pub backend: String,
    pub model: String,
}

fn read_service_password(path: &std::path::Path) -> Option<String> {
    let data = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    v.get("password").and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn discover_opencode_host(cfg: &Config) -> Option<String> {
    if let Some(h) = &cfg.opencode_host {
        return Some(h.clone());
    }
    let out = Command::new("opencode")
        .args(["service", "status"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.lines().next()?.trim().to_string();
    if line.starts_with("http://") || line.starts_with("https://") {
        Some(line)
    } else {
        None
    }
}

pub fn clip(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let slice = &text[..end];
    if let Some(cut) = slice.rfind('\n') {
        if cut > max_bytes / 2 {
            return format!("{}\n\n[... truncated at {max_bytes} bytes ...]", &slice[..cut]);
        }
    }
    format!("{slice}\n\n[... truncated at {max_bytes} bytes ...]")
}

fn ollama_generate(cfg: &Config, prompt: &str) -> Result<AiResult, String> {
    let url = format!("{}/api/generate", cfg.ollama_host.trim_end_matches('/'));
    let body = json!({
        "model": cfg.ollama_model,
        "prompt": prompt,
        "stream": false,
        "options": { "temperature": 0.2, "num_ctx": 8192 }
    });
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(180))
        .set("content-type", "application/json")
        .send_json(body)
        .map_err(|e| format!("ollama: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| format!("ollama: {e}"))?;
    let text = v.get("response").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let model = v.get("model").and_then(|x| x.as_str()).unwrap_or(&cfg.ollama_model).to_string();
    Ok(AiResult { text, backend: "ollama".into(), model })
}

fn opencode_generate(cfg: &Config, prompt: &str, model: Option<(&str, &str)>) -> Result<AiResult, String> {
    let host = discover_opencode_host(cfg).ok_or_else(|| "opencode service not running".to_string())?;
    let pw = read_service_password(&cfg.opencode_password_file)
        .ok_or_else(|| "no opencode service credentials".to_string())?;
    let auth = B64.encode(format!("opencode:{pw}"));
    let mut body = json!({ "prompt": prompt });
    if let Some((provider, id)) = model {
        body["model"] = json!({ "id": id, "providerID": provider });
    }
    let url = format!("{host}/api/experimental/generate/text");
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(180))
        .set("content-type", "application/json")
        .set("authorization", &format!("Basic {auth}"))
        .send_json(body)
        .map_err(|e| format!("opencode: {e}"))?;
    let v: serde_json::Value = resp.into_json().map_err(|e| format!("opencode: {e}"))?;
    let text = v.get("data").and_then(|d| d.get("text")).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let label = model.map(|(p, i)| format!("{p}/{i}")).unwrap_or_else(|| "opencode".into());
    Ok(AiResult { text, backend: "opencode".into(), model: label })
}

pub fn generate(cfg: &Config, prompt: &str, model: Option<(&str, &str)>) -> Result<AiResult, String> {
    let order: Vec<&str> = match cfg.ai_backend.as_str() {
        "ollama" => vec!["ollama"],
        "opencode" => vec!["opencode"],
        _ => vec!["ollama", "opencode"],
    };
    let mut errors = Vec::new();
    for b in order {
        let res = if b == "ollama" {
            ollama_generate(cfg, prompt)
        } else {
            opencode_generate(cfg, prompt, model)
        };
        match res {
            Ok(r) => return Ok(r),
            Err(e) => errors.push(e),
        }
    }
    Err(format!("no AI backend could answer. {}", errors.join(" | ")))
}

pub fn summarize_prompt(title: &str, transcript: &str, status: &str) -> String {
    format!(
        "Summarise this AI agent working session so a human maintainer can understand what the agent actually did.\n\n\
Session title: {title}\n\nRepository state:\n{status}\n\nTranscript:\n{transcript}\n\n\
Answer in short bullet points:\n1. What was asked\n2. What the agent did, step by step\n3. What it changed on disk, if stated\n4. What was left unfinished or needs a human check"
    )
}

pub fn review_prompt(diff: &str, branch: &str, base: &str) -> String {
    format!(
        "Review this change as a careful maintainer would.\n\nBranch: {branch}\nBase: {base}\n\nDiff:\n{diff}\n\n\
Report:\n1. Intent\n2. Correctness — anything wrong or likely to break, with file/line refs\n3. Risk\n4. Missing\n\
Be blunt. If it looks fine, say so in one line."
    )
}

pub fn draft_message_prompt(diff: &str) -> String {
    format!(
        "Write a commit message for this change.\n\nDiff:\n{diff}\n\n\
Produce: a conventional-commit subject line (max 72 chars, type(scope): summary), then a short paragraph body explaining what and why. No bullets, no headers."
    )
}
