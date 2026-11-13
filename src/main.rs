//! Reason — AI-native Git client dashboard (GTK C+Rust).
//!
//! A native GTK4 application that joins the state of Git repositories with the
//! activity of AI agent sessions on this machine. No browser, no web server.

mod actions;
mod ai;
mod config;
mod git;
mod graph;
mod sessions;

use gtk4::glib;
use gtk4::prelude::*;
use gtk4::{
    pango, Align, Application, ApplicationWindow, Box as GtkBox, Button, DrawingArea, GestureClick,
    Label, ListBox, ListBoxRow, Notebook, Orientation, Paned, PolicyType, ScrolledWindow,
    SelectionMode, TextView,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

const ROW_H: f64 = 28.0;
const TOP_PAD: f64 = 20.0;

#[derive(Clone)]
struct AppState {
    cfg: config::Config,
    repos: Vec<git::RepoInfo>,
    selected_repo: Option<String>,
    commits: Vec<git::Commit>,
    graph: Option<graph::Graph>,
    sessions: Vec<sessions::Session>,
    selected_commit: Option<usize>,
    selected_session: Option<String>,
}

impl AppState {
    fn new(cfg: config::Config) -> Self {
        Self {
            cfg,
            repos: Vec::new(),
            selected_repo: None,
            commits: Vec::new(),
            graph: None,
            sessions: Vec::new(),
            selected_commit: None,
            selected_session: None,
        }
    }
}

fn scan(state: &mut AppState) {
    let paths = git::discover_repos(&state.cfg.roots, &state.cfg.skip_dirs);
    let mut repos = Vec::new();
    for p in &paths {
        if let Some(info) = git::repo_info(p, &state.cfg.base_branches) {
            repos.push(info);
        }
    }
    let repo_paths: Vec<String> = repos.iter().map(|r| r.path.clone()).collect();
    state.sessions = sessions::list_sessions(&state.cfg.opencode_db, &repo_paths);
    state.repos = repos;
}

fn load_repo(state: &mut AppState, path: &str) {
    state.selected_repo = Some(path.to_string());
    state.selected_commit = None;
    let p = std::path::Path::new(path);
    let commits = git::commit_log(p, state.cfg.max_commits);
    state.graph = Some(graph::build(commits.clone()));
    state.commits = commits;
}

fn short_path(path: &str, home: &str) -> String {
    if let Some(rest) = path.strip_prefix(home) {
        format!("~{rest}")
    } else {
        path.to_string()
    }
}

fn make_label(text: &str, class: Option<&str>) -> Label {
    let l = Label::new(Some(text));
    l.set_xalign(0.0);
    l.set_wrap(true);
    l.set_wrap_mode(pango::WrapMode::WordChar);
    l.set_selectable(true);
    if let Some(c) = class {
        l.add_css_class(c);
    }
    l
}

fn build_repo_row(repo: &git::RepoInfo, home: &str, agent_count: usize) -> ListBoxRow {
    let row = ListBoxRow::new();
    let v = GtkBox::new(Orientation::Vertical, 2);
    v.set_margin_top(6);
    v.set_margin_bottom(6);
    v.set_margin_start(8);
    v.set_margin_end(8);

    let top = GtkBox::new(Orientation::Horizontal, 8);
    let name = Label::new(Some(&repo.name));
    name.set_xalign(0.0);
    name.add_css_class("repo-name");
    name.set_hexpand(true);
    name.set_halign(Align::Start);
    top.append(&name);
    let branch = Label::new(Some(repo.branch.as_deref().unwrap_or("detached")));
    branch.add_css_class("repo-branch");
    top.append(&branch);
    v.append(&top);

    let mut meta_parts = vec![short_path(&repo.path, home)];
    if repo.dirty_files > 0 {
        meta_parts.push(format!("{} dirty", repo.dirty_files));
    }
    if let Some(a) = repo.ahead { if a > 0 { meta_parts.push(format!("↑{a}")); } }
    if let Some(b) = repo.behind { if b > 0 { meta_parts.push(format!("↓{b}")); } }
    if repo.stashes > 0 {
        meta_parts.push(format!("{} stash", repo.stashes));
    }
    if agent_count > 0 {
        meta_parts.push(format!("{agent_count} agent{}", if agent_count == 1 { "" } else { "s" }));
    }
    let meta = Label::new(Some(&meta_parts.join(" · ")));
    meta.set_xalign(0.0);
    meta.add_css_class("repo-meta");
    meta.set_ellipsize(gtk4::pango::EllipsizeMode::End);
    v.append(&meta);

    row.set_child(Some(&v));
    row
}

fn build_session_row(session: &sessions::Session, repo_dirty: bool) -> ListBoxRow {
    let row = ListBoxRow::new();
    let v = GtkBox::new(Orientation::Vertical, 2);
    v.set_margin_top(6);
    v.set_margin_bottom(6);
    v.set_margin_start(8);
    v.set_margin_end(8);

    let title = Label::new(Some(&session.title));
    title.set_xalign(0.0);
    title.set_hexpand(true);
    title.set_halign(Align::Start);
    title.set_ellipsize(gtk4::pango::EllipsizeMode::End);
    title.add_css_class("session-title");
    v.append(&title);

    let repo_name = session
        .repo_path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| session.scope.clone());

    let tokens = session.tokens_input + session.tokens_output + session.tokens_reasoning;
    let mut meta = vec![session.state.clone(), repo_name];
    if let Some(a) = &session.agent { meta.push(a.clone()); }
    if let Some(m) = &session.model_id { meta.push(m.clone()); }
    meta.push(format!("{:.1}k tok", tokens as f64 / 1000.0));
    if repo_dirty { meta.push("⚠ repo dirty".into()); }

    let meta_label = Label::new(Some(&meta.join(" · ")));
    meta_label.set_xalign(0.0);
    meta_label.add_css_class(if repo_dirty { "session-meta-dirty" } else { "session-meta" });
    meta_label.set_ellipsize(gtk4::pango::EllipsizeMode::End);
    v.append(&meta_label);

    row.set_child(Some(&v));
    row
}

fn refresh_repo_list(list: &ListBox, state: &AppState) {
    while let Some(child) = list.first_child() { list.remove(&child); }
    let home = config::dirs_home().to_string_lossy().to_string();
    for repo in &state.repos {
        let count = state.sessions.iter().filter(|s| s.repo_path.as_deref() == Some(&repo.path)).count();
        list.append(&build_repo_row(repo, &home, count));
    }
}

fn refresh_session_list(list: &ListBox, state: &AppState) {
    while let Some(child) = list.first_child() { list.remove(&child); }
    let filtered: Vec<&sessions::Session> = if let Some(sel) = &state.selected_repo {
        state.sessions.iter().filter(|s| s.repo_path.as_deref() == Some(sel.as_str())).collect()
    } else {
        state.sessions.iter().collect()
    };
    for session in filtered.iter().take(200) {
        let dirty = session.repo_path.as_ref()
            .and_then(|rp| state.repos.iter().find(|r| &r.path == rp))
            .map(|r| r.dirty_files > 0)
            .unwrap_or(false);
        list.append(&build_session_row(session, dirty));
    }
}

fn clear_box(b: &GtkBox) {
    while let Some(child) = b.first_child() { b.remove(&child); }
}

fn show_commit_detail(detail: &GtkBox, ai_output: &TextView, state: &AppState, idx: usize) {
    clear_box(detail);
    let Some(commit) = state.commits.get(idx) else { return };
    let Some(repo_path) = &state.selected_repo else { return };

    detail.append(&make_label(&commit.subject, Some("detail-title")));
    let meta = format!(
        "{}\n{} <{}>\n{}\nrefs: {}",
        &commit.sha,
        commit.author,
        commit.email,
        commit.at,
        commit.refs.iter().map(|r| r.short.as_str()).collect::<Vec<_>>().join(", ")
    );
    detail.append(&make_label(&meta, Some("detail-meta")));
    if !commit.body.is_empty() {
        detail.append(&make_label(&commit.body, Some("detail-body")));
    }

    // Diff
    match git::commit_diff(std::path::Path::new(repo_path), &commit.sha) {
        Ok(diff) => {
            detail.append(&make_label("Diff:", Some("section-header")));
            let tv = TextView::new();
            tv.set_editable(false);
            tv.set_monospace(true);
            tv.set_wrap_mode(gtk4::WrapMode::None);
            tv.buffer().set_text(&diff);
            let scroll = ScrolledWindow::builder()
                .hscrollbar_policy(PolicyType::Automatic)
                .vscrollbar_policy(PolicyType::Automatic)
                .min_content_height(300)
                .vexpand(true)
                .child(&tv)
                .build();
            detail.append(&scroll);

            // AI review button
            let diff_owned = diff.clone();
            let sha_short = commit.sha[..8.min(commit.sha.len())].to_string();
            let cfg = state.cfg.clone();
            let ai_out = ai_output.clone();
            let btn = Button::with_label("Review this change (AI)");
            btn.connect_clicked(move |_| {
                let prompt = ai::review_prompt(&ai::clip(&diff_owned, 32000), "(commit)", "(parent)");
                run_ai(&cfg, prompt, ai_out.clone(), Some(format!("Review {sha_short}")));
            });
            detail.append(&btn);
        }
        Err(e) => {
            detail.append(&make_label(&format!("Could not load diff: {e}"), Some("error")));
        }
    }
}

fn show_transcript(detail: &GtkBox, ai_output: &TextView, state: &AppState, session_id: &str) {
    clear_box(detail);
    let Some(session) = state.sessions.iter().find(|s| s.id == session_id) else { return };
    detail.append(&make_label(&session.title, Some("detail-title")));
    let meta = format!(
        "{} · {} · {} · {:.1}k tokens · ${:.4}",
        session.directory,
        session.agent.as_deref().unwrap_or("?"),
        session.model_id.as_deref().unwrap_or("?"),
        (session.tokens_input + session.tokens_output + session.tokens_reasoning) as f64 / 1000.0,
        session.cost
    );
    detail.append(&make_label(&meta, Some("detail-meta")));

    let transcript = sessions::transcript(&state.cfg.opencode_db, session_id);
    if transcript.is_empty() {
        detail.append(&make_label("No transcript messages.", Some("repo-meta")));
    } else {
        detail.append(&make_label(&format!("{} messages:", transcript.len()), Some("section-header")));
        let scroll = ScrolledWindow::builder()
            .hscrollbar_policy(PolicyType::Never)
            .vscrollbar_policy(PolicyType::Automatic)
            .min_content_height(350)
            .vexpand(true)
            .build();
        let boxv = GtkBox::new(Orientation::Vertical, 6);
        boxv.set_margin_end(8);
        for msg in &transcript {
            let role = if msg.r#type == "user" { "Human" } else if msg.r#type == "assistant" { "Agent" } else { &msg.r#type };
            boxv.append(&make_label(&format!("[{role}]"), Some("msg-role")));
            let text = if msg.text.len() > 4000 { format!("{}…", &msg.text[..4000]) } else { msg.text.clone() };
            boxv.append(&make_label(&text, Some("msg-body")));
        }
        scroll.set_child(Some(&boxv));
        detail.append(&scroll);

        // Summarize button
        let title = session.title.clone();
        let cfg = state.cfg.clone();
        let db = state.cfg.opencode_db.clone();
        let sid = session_id.to_string();
        let ai_out = ai_output.clone();
        let btn = Button::with_label("Summarize this session (AI)");
        btn.connect_clicked(move |_| {
            let transcript = sessions::transcript(&db, &sid);
            let text = transcript.iter().map(|m| {
                let role = if m.r#type == "user" { "Human" } else { "Agent" };
                format!("{role}: {}", m.text)
            }).collect::<Vec<_>>().join("\n\n");
            let prompt = ai::summarize_prompt(&title, &ai::clip(&text, 24000), "(not available)");
            run_ai(&cfg, prompt, ai_out.clone(), Some(format!("Summarize: {title}")));
        });
        detail.append(&btn);
    }
}

fn run_ai(cfg: &config::Config, prompt: String, output: TextView, label: Option<String>) {
    output.buffer().set_text(&format!("Thinking… ({})\n", label.unwrap_or_default()));
    let cfg = cfg.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<ai::AiResult, String>>();
    std::thread::spawn(move || {
        let res = ai::generate(&cfg, &prompt, None);
        let _ = tx.send(res);
    });
    glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
        match rx.try_recv() {
            Ok(Ok(r)) => {
                output.buffer().set_text(&format!("[via {} · {}]\n\n{}", r.backend, r.model, r.text));
                glib::ControlFlow::Break
            }
            Ok(Err(e)) => {
                output.buffer().set_text(&format!("AI error: {e}"));
                glib::ControlFlow::Break
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => glib::ControlFlow::Continue,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                output.buffer().set_text("AI worker disconnected.");
                glib::ControlFlow::Break
            }
        }
    });
}

fn build_ui(app: &Application) {
    let cfg = config::load();
    let state = Rc::new(RefCell::new(AppState::new(cfg)));
    { let mut s = state.borrow_mut(); scan(&mut s); }

    let window = ApplicationWindow::builder()
        .application(app)
        .title("Reason — AI-native Git client")
        .default_width(1500)
        .default_height(950)
        .build();

    let outer = Paned::new(Orientation::Horizontal);
    let inner = Paned::new(Orientation::Horizontal);
    outer.set_end_child(Some(&inner));
    outer.set_shrink_start_child(false);
    outer.set_resize_start_child(false);
    outer.set_position(300);
    inner.set_shrink_end_child(false);
    inner.set_resize_end_child(false);
    inner.set_position(820);

    // Left: repos
    let repo_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Never).vscrollbar_policy(PolicyType::Automatic).build();
    let repo_list = ListBox::new();
    repo_list.set_selection_mode(SelectionMode::Single);
    repo_scroll.set_child(Some(&repo_list));
    outer.set_start_child(Some(&repo_scroll));

    // Center: graph + detail
    let center = Paned::new(Orientation::Vertical);
    center.set_position(500);
    let graph_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Automatic).vscrollbar_policy(PolicyType::Automatic).build();
    let graph_area = DrawingArea::new();
    graph_area.set_content_width(1000);
    graph_area.set_content_height(400);
    graph_scroll.set_child(Some(&graph_area));
    center.set_start_child(Some(&graph_scroll));

    let detail_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Automatic).vscrollbar_policy(PolicyType::Automatic).build();
    let detail_box = GtkBox::new(Orientation::Vertical, 6);
    detail_box.set_margin_top(8); detail_box.set_margin_bottom(8);
    detail_box.set_margin_start(10); detail_box.set_margin_end(10);
    detail_box.append(&make_label("Select a repository, then click a commit or a session.", Some("repo-meta")));
    detail_scroll.set_child(Some(&detail_box));
    center.set_end_child(Some(&detail_scroll));
    inner.set_start_child(Some(&center));

    // Right: notebook (Sessions / AI)
    let notebook = Notebook::new();
    notebook.set_scrollable(true);

    // Sessions tab
    let session_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Never).vscrollbar_policy(PolicyType::Automatic).vexpand(true).build();
    let session_list = ListBox::new();
    session_list.set_selection_mode(SelectionMode::Single);
    session_scroll.set_child(Some(&session_list));
    notebook.append_page(&session_scroll, Some(&Label::new(Some("Agents"))));

    // AI tab
    let ai_box = GtkBox::new(Orientation::Vertical, 6);
    ai_box.set_margin_top(8); ai_box.set_margin_bottom(8);
    ai_box.set_margin_start(8); ai_box.set_margin_end(8);
    ai_box.append(&make_label("AI panel — local backends only (opencode / Ollama).", Some("repo-meta")));
    let ai_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Automatic).vscrollbar_policy(PolicyType::Automatic).vexpand(true).build();
    let ai_output = TextView::new();
    ai_output.set_editable(false);
    ai_output.set_wrap_mode(gtk4::WrapMode::WordChar);
    ai_output.set_monospace(true);
    ai_output.buffer().set_text("Select a commit and click \"Review this change\", or select a session and click \"Summarize\".");
    ai_scroll.set_child(Some(&ai_output));
    ai_box.append(&ai_scroll);
    notebook.append_page(&ai_box, Some(&Label::new(Some("AI"))));

    inner.set_end_child(Some(&notebook));
    window.set_child(Some(&outer));

    // Initial data
    { let s = state.borrow(); refresh_repo_list(&repo_list, &s); refresh_session_list(&session_list, &s); }

    // Graph drawing
    {
        let st = state.clone();
        graph_area.set_draw_func(move |_area, cr, width, height| {
            let s = st.borrow();
            cr.set_source_rgb(0.05, 0.07, 0.09);
            cr.rectangle(0.0, 0.0, width as f64, height as f64);
            let _ = cr.fill();

            let Some(graph) = &s.graph else {
                cr.set_source_rgb(0.55, 0.6, 0.66);
                cr.move_to(20.0, 30.0);
                let _ = cr.show_text("Select a repository");
                return;
            };
            let col_w = 18.0f64;
            let left_pad = 16.0f64;
            let lane_area = left_pad + (graph.column_count.max(1) as f64) * col_w + 20.0;
            let mut idx_of: HashMap<&str, usize> = HashMap::new();
            for (i, n) in graph.nodes.iter().enumerate() { idx_of.insert(n.commit.sha.as_str(), i); }

            // highlight selected row
            if let Some(sel) = s.selected_commit {
                let y = TOP_PAD + (sel as f64) * ROW_H;
                cr.set_source_rgba(0.36, 0.55, 0.94, 0.15);
                cr.rectangle(0.0, y - ROW_H / 2.0, width as f64, ROW_H);
                let _ = cr.fill();
            }

            // Edges
            cr.set_source_rgb(0.25, 0.32, 0.40);
            cr.set_line_width(1.5);
            for n in &graph.nodes {
                let x1 = left_pad + (n.col as f64) * col_w;
                let y1 = TOP_PAD + (n.row as f64) * ROW_H;
                for p in &n.commit.parents {
                    if let Some(&pi) = idx_of.get(p.as_str()) {
                        let pn = &graph.nodes[pi];
                        let x2 = left_pad + (pn.col as f64) * col_w;
                        let y2 = TOP_PAD + (pn.row as f64) * ROW_H;
                        cr.move_to(x1, y1);
                        let mid = (y1 + y2) / 2.0;
                        cr.curve_to(x1, mid, x2, mid, x2, y2);
                        let _ = cr.stroke();
                    }
                }
            }

            // Nodes and labels
            for n in &graph.nodes {
                let x = left_pad + (n.col as f64) * col_w;
                let y = TOP_PAD + (n.row as f64) * ROW_H;
                if n.commit.parents.len() > 1 { cr.set_source_rgb(0.36, 0.55, 0.94); }
                else { cr.set_source_rgb(0.55, 0.6, 0.66); }
                cr.arc(x, y, 4.0, 0.0, std::f64::consts::PI * 2.0);
                let _ = cr.fill();

                let mut tx = lane_area;
                for r in &n.commit.refs {
                    if !r.remote { cr.set_source_rgb(0.25, 0.75, 0.63); }
                    else { cr.set_source_rgb(0.38, 0.42, 0.48); }
                    cr.move_to(tx, y + 4.0);
                    let _ = cr.show_text(&r.short);
                    tx += (r.short.len() as f64) * 7.0 + 10.0;
                }
                cr.set_source_rgb(0.84, 0.87, 0.91);
                cr.move_to(tx, y + 4.0);
                let subj = if n.commit.subject.len() > 90 { format!("{}…", &n.commit.subject[..90]) } else { n.commit.subject.clone() };
                let _ = cr.show_text(&subj);
            }
        });
    }

    // Click on graph -> select commit
    {
        let st = state.clone();
        let graph_area_c = graph_area.clone();
        let detail_box_c = detail_box.clone();
        let ai_out_c = ai_output.clone();
        let click = GestureClick::new();
        click.connect_released(move |_g, _n, _x, y| {
            let mut s = st.borrow_mut();
            let count = s.commits.len();
            if count == 0 { return; }
            let row = ((y - TOP_PAD + ROW_H / 2.0) / ROW_H).floor() as isize;
            if row < 0 || row as usize >= count { return; }
            let idx = row as usize;
            s.selected_commit = Some(idx);
            drop(s);
            let s = st.borrow();
            show_commit_detail(&detail_box_c, &ai_out_c, &s, idx);
            graph_area_c.queue_draw();
        });
        graph_area.add_controller(click);
    }

    // Repo selection
    {
        let st = state.clone();
        let session_list_c = session_list.clone();
        let graph_area_c = graph_area.clone();
        let detail_box_c = detail_box.clone();
        repo_list.connect_row_selected(move |_list, row| {
            let Some(row) = row else { return };
            let idx = row.index() as usize;
            let mut s = st.borrow_mut();
            if idx >= s.repos.len() { return; }
            let path = s.repos[idx].path.clone();
            load_repo(&mut s, &path);
            if let Some(g) = &s.graph {
                graph_area_c.set_content_height(((g.nodes.len() as i32) * 28 + 60).max(400));
                graph_area_c.set_content_width(((g.column_count.max(1)) * 18 + 1000).max(900));
            }
            clear_box(&detail_box_c);
            let head = s.commits.first().map(|c| format!("{} — {}", &c.sha[..8.min(c.sha.len())], c.subject)).unwrap_or_default();
            detail_box_c.append(&make_label(&format!("{}\n{} commits · {} agent sessions\nHEAD: {head}",
                path, s.commits.len(),
                s.sessions.iter().filter(|x| x.repo_path.as_deref() == Some(path.as_str())).count()
            ), Some("repo-meta")));
            refresh_session_list(&session_list_c, &s);
            graph_area_c.queue_draw();
        });
    }

    // Session selection -> transcript
    {
        let st = state.clone();
        let detail_box_c = detail_box.clone();
        let ai_out_c = ai_output.clone();
        let notebook_c = notebook.clone();
        session_list.connect_row_selected(move |_list, row| {
            let Some(row) = row else { return };
            let idx = row.index() as usize;
            let mut s = st.borrow_mut();
            let sel = s.selected_repo.clone();
            let filtered: Vec<String> = if let Some(sel) = &sel {
                s.sessions.iter().filter(|x| x.repo_path.as_deref() == Some(sel.as_str())).map(|x| x.id.clone()).collect()
            } else {
                s.sessions.iter().map(|x| x.id.clone()).collect()
            };
            if idx >= filtered.len() { return; }
            let sid = filtered[idx].clone();
            s.selected_session = Some(sid.clone());
            drop(s);
            let s = st.borrow();
            show_transcript(&detail_box_c, &ai_out_c, &s, &sid);
            notebook_c.set_current_page(Some(0)); // keep agents tab context, detail shows transcript
        });
    }

    // Periodic refresh
    {
        let st = state.clone();
        let repo_list_c = repo_list.clone();
        let session_list_c = session_list.clone();
        glib::timeout_add_seconds_local(5, move || {
            {
                let mut s = st.borrow_mut();
                let selected = s.selected_repo.clone();
                scan(&mut s);
                s.selected_repo = selected;
            }
            let s = st.borrow();
            refresh_repo_list(&repo_list_c, &s);
            refresh_session_list(&session_list_c, &s);
            glib::ControlFlow::Continue
        });
    }

    // CSS
    let provider = gtk4::CssProvider::new();
    provider.load_from_data(
        "window { background: #0d1117; color: #d7dee8; }
         .repo-name { font-weight: 600; }
         .repo-branch { color: #5b8def; font-family: monospace; font-size: 11px; }
         .repo-meta, .session-meta { color: #7a8899; font-size: 11px; }
         .session-meta-dirty { color: #e2a03f; font-size: 11px; }
         .session-title { font-weight: 500; }
         .detail-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
         .detail-meta { color: #8b98a9; font-family: monospace; font-size: 11px; }
         .detail-body { color: #b0bac6; margin-top: 6px; }
         .section-header { font-weight: 600; color: #b0bac6; margin-top: 8px; }
         .msg-role { color: #5b8def; font-weight: 600; font-size: 11px; }
         .msg-body { color: #d7dee8; font-size: 12px; }
         .error { color: #e05a5a; }
         textview { background: #131a23; color: #d7dee8; }
         textview text { background: #131a23; color: #d7dee8; }
         listbox { background: #0d1117; }
         listboxrow:selected { background: #223042; }
         notebook header { background: #131a23; }
         paned separator { background: #232c38; min-width: 1px; min-height: 1px; }",
    );
    if let Some(display) = gtk4::gdk::Display::default() {
        gtk4::style_context_add_provider_for_display(&display, &provider, gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    window.present();
    if !state.borrow().repos.is_empty() {
        if let Some(row) = repo_list.row_at_index(0) { repo_list.select_row(Some(&row)); }
    }
}

fn main() {
    let app = Application::builder().application_id("org.acreetionos.reason").build();
    app.connect_activate(build_ui);
    app.run();
}
