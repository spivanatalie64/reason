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

use gtk4::prelude::*;
use gtk4::{
    Application, ApplicationWindow, Box as GtkBox, DrawingArea, Label, ListBox, ListBoxRow,
    Orientation, Paned, PolicyType, ScrolledWindow, SelectionMode,
};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone)]
struct AppState {
    cfg: config::Config,
    repos: Vec<git::RepoInfo>,
    selected_repo: Option<String>,
    commits: Vec<git::Commit>,
    graph: Option<graph::Graph>,
    sessions: Vec<sessions::Session>,
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
    // Attribute sessions against all discovered repo paths.
    let repo_paths: Vec<String> = repos.iter().map(|r| r.path.clone()).collect();
    state.sessions = sessions::list_sessions(&state.cfg.opencode_db, &repo_paths);
    state.repos = repos;
}

fn load_repo(state: &mut AppState, path: &str) {
    state.selected_repo = Some(path.to_string());
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
    name.set_halign(gtk4::Align::Start);
    top.append(&name);

    let branch_text = repo.branch.clone().unwrap_or_else(|| "detached".into());
    let branch = Label::new(Some(&branch_text));
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

fn build_session_row(session: &sessions::Session) -> ListBoxRow {
    let row = ListBoxRow::new();
    let v = GtkBox::new(Orientation::Vertical, 2);
    v.set_margin_top(6);
    v.set_margin_bottom(6);
    v.set_margin_start(8);
    v.set_margin_end(8);

    let title = Label::new(Some(&session.title));
    title.set_xalign(0.0);
    title.set_hexpand(true);
    title.set_halign(gtk4::Align::Start);
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

    let meta_label = Label::new(Some(&meta.join(" · ")));
    meta_label.set_xalign(0.0);
    meta_label.add_css_class("session-meta");
    meta_label.set_ellipsize(gtk4::pango::EllipsizeMode::End);
    v.append(&meta_label);

    row.set_child(Some(&v));
    row
}

fn refresh_repo_list(list: &ListBox, state: &AppState) {
    while let Some(child) = list.first_child() {
        list.remove(&child);
    }
    let home = config::dirs_home().to_string_lossy().to_string();
    for repo in &state.repos {
        let count = state.sessions.iter().filter(|s| s.repo_path.as_deref() == Some(&repo.path)).count();
        list.append(&build_repo_row(repo, &home, count));
    }
}

fn refresh_session_list(list: &ListBox, state: &AppState) {
    while let Some(child) = list.first_child() {
        list.remove(&child);
    }
    let filtered: Vec<&sessions::Session> = if let Some(sel) = &state.selected_repo {
        state.sessions.iter().filter(|s| s.repo_path.as_deref() == Some(sel.as_str())).collect()
    } else {
        state.sessions.iter().collect()
    };
    for session in filtered.iter().take(200) {
        list.append(&build_session_row(session));
    }
}

fn refresh_graph(area: &DrawingArea, state: &AppState) {
    area.queue_draw();
    let _ = state;
}

fn build_ui(app: &Application) {
    let cfg = config::load();
    let state = Rc::new(RefCell::new(AppState::new(cfg)));
    {
        let mut s = state.borrow_mut();
        scan(&mut s);
    }

    let window = ApplicationWindow::builder()
        .application(app)
        .title("Reason — AI-native Git client")
        .default_width(1400)
        .default_height(900)
        .build();

    // Top-level: left (repos) | center (graph/diff) | right (agents/AI)
    let outer = Paned::new(Orientation::Horizontal);
    let inner = Paned::new(Orientation::Horizontal);
    outer.set_end_child(Some(&inner));
    outer.set_shrink_start_child(false);
    outer.set_resize_start_child(false);
    outer.set_position(280);
    inner.set_shrink_end_child(false);
    inner.set_resize_end_child(false);
    inner.set_position(780);

    // --- Left: repositories ---
    let repo_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Never)
        .vscrollbar_policy(PolicyType::Automatic)
        .build();
    let repo_list = ListBox::new();
    repo_list.set_selection_mode(SelectionMode::Single);
    repo_scroll.set_child(Some(&repo_list));
    outer.set_start_child(Some(&repo_scroll));

    // --- Center: commit graph + detail ---
    let center = Paned::new(Orientation::Vertical);
    center.set_position(520);

    let graph_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Automatic)
        .vscrollbar_policy(PolicyType::Automatic)
        .build();
    let graph_area = DrawingArea::new();
    graph_area.set_content_width(900);
    graph_area.set_content_height(400);
    graph_scroll.set_child(Some(&graph_area));
    center.set_start_child(Some(&graph_scroll));

    let detail_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Automatic)
        .vscrollbar_policy(PolicyType::Automatic)
        .build();
    let detail_box = GtkBox::new(Orientation::Vertical, 4);
    detail_box.set_margin_top(8);
    detail_box.set_margin_bottom(8);
    detail_box.set_margin_start(10);
    detail_box.set_margin_end(10);
    let detail_placeholder = Label::new(Some("Select a commit to see its details."));
    detail_placeholder.set_xalign(0.0);
    detail_box.append(&detail_placeholder);
    detail_scroll.set_child(Some(&detail_box));
    center.set_end_child(Some(&detail_scroll));
    inner.set_start_child(Some(&center));

    // --- Right: agent sessions ---
    let right = GtkBox::new(Orientation::Vertical, 0);
    let sessions_header = Label::new(Some("Agent sessions"));
    sessions_header.set_xalign(0.0);
    sessions_header.set_margin_top(8);
    sessions_header.set_margin_bottom(4);
    sessions_header.set_margin_start(8);
    sessions_header.add_css_class("panel-header");
    right.append(&sessions_header);
    let session_scroll = ScrolledWindow::builder()
        .hscrollbar_policy(PolicyType::Never)
        .vscrollbar_policy(PolicyType::Automatic)
        .vexpand(true)
        .build();
    let session_list = ListBox::new();
    session_list.set_selection_mode(SelectionMode::Single);
    session_scroll.set_child(Some(&session_list));
    right.append(&session_scroll);
    inner.set_end_child(Some(&right));

    window.set_child(Some(&outer));

    // Initial population
    {
        let s = state.borrow();
        refresh_repo_list(&repo_list, &s);
        refresh_session_list(&session_list, &s);
    }

    // Graph drawing: lanes on the left, subjects on the right.
    {
        let st = state.clone();
        graph_area.set_draw_func(move |_area, cr, width, height| {
            let s = st.borrow();
            // background
            cr.set_source_rgb(0.05, 0.07, 0.09);
            cr.rectangle(0.0, 0.0, width as f64, height as f64);
            let _ = cr.fill();

            let Some(graph) = &s.graph else {
                cr.set_source_rgb(0.55, 0.6, 0.66);
                cr.move_to(20.0, 30.0);
                let _ = cr.show_text("Select a repository");
                return;
            };
            let row_h = 28.0f64;
            let col_w = 18.0f64;
            let left_pad = 16.0f64;
            let top_pad = 20.0f64;
            let lane_area = left_pad + (graph.column_count.max(1) as f64) * col_w + 20.0;

            // Index for parent lookup.
            let mut idx_of: HashMap<&str, usize> = HashMap::new();
            for (i, n) in graph.nodes.iter().enumerate() {
                idx_of.insert(n.commit.sha.as_str(), i);
            }

            // Edges
            cr.set_source_rgb(0.25, 0.32, 0.40);
            cr.set_line_width(1.5);
            for n in &graph.nodes {
                let x1 = left_pad + (n.col as f64) * col_w;
                let y1 = top_pad + (n.row as f64) * row_h;
                for p in &n.commit.parents {
                    if let Some(&pi) = idx_of.get(p.as_str()) {
                        let pn = &graph.nodes[pi];
                        let x2 = left_pad + (pn.col as f64) * col_w;
                        let y2 = top_pad + (pn.row as f64) * row_h;
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
                let y = top_pad + (n.row as f64) * row_h;
                let is_merge = n.commit.parents.len() > 1;
                if is_merge {
                    cr.set_source_rgb(0.36, 0.55, 0.94);
                } else {
                    cr.set_source_rgb(0.55, 0.6, 0.66);
                }
                cr.arc(x, y, 4.0, 0.0, std::f64::consts::PI * 2.0);
                let _ = cr.fill();

                // Label
                let mut tx = lane_area;
                // refs
                for r in &n.commit.refs {
                    let label = &r.short;
                    if !r.remote {
                        cr.set_source_rgb(0.25, 0.75, 0.63);
                    } else {
                        cr.set_source_rgb(0.38, 0.42, 0.48);
                    }
                    cr.move_to(tx, y + 4.0);
                    let _ = cr.show_text(label);
                    tx += (label.len() as f64) * 7.0 + 10.0;
                }
                cr.set_source_rgb(0.84, 0.87, 0.91);
                cr.move_to(tx, y + 4.0);
                let subj = if n.commit.subject.len() > 80 {
                    format!("{}…", &n.commit.subject[..80])
                } else {
                    n.commit.subject.clone()
                };
                let _ = cr.show_text(&subj);
            }
        });
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

            // Resize graph area to content
            if let Some(g) = &s.graph {
                let h = (g.nodes.len() as i32) * 28 + 60;
                let w = (g.column_count.max(1)) * 18 + 900;
                graph_area_c.set_content_width(w);
                graph_area_c.set_content_height(h);
            }

            // Detail: show repo summary
            while let Some(child) = detail_box_c.first_child() {
                detail_box_c.remove(&child);
            }
            let head = s.commits.first().map(|c| format!("{} — {}", &c.sha[..8.min(c.sha.len())], c.subject)).unwrap_or_default();
            let info = Label::new(Some(&format!("{}\n{} commits loaded\nHEAD: {head}", path, s.commits.len())));
            info.set_xalign(0.0);
            info.set_wrap(true);
            detail_box_c.append(&info);

            refresh_session_list(&session_list_c, &s);
            graph_area_c.queue_draw();
        });
    }

    // Periodic refresh (repo status + sessions)
    {
        let st = state.clone();
        let repo_list_c = repo_list.clone();
        let session_list_c = session_list.clone();
        glib::timeout_add_seconds_local(5, move || {
            {
                let mut s = st.borrow_mut();
                let selected = s.selected_repo.clone();
                scan(&mut s);
                // Keep selection stable by path.
                s.selected_repo = selected;
            }
            let s = st.borrow();
            refresh_repo_list(&repo_list_c, &s);
            refresh_session_list(&session_list_c, &s);
            glib::ControlFlow::Continue
        });
    }

    // Basic CSS
    let provider = gtk4::CssProvider::new();
    provider.load_from_data(
        ".repo-name { font-weight: 600; }
         .repo-branch { color: #5b8def; font-family: monospace; font-size: 11px; }
         .repo-meta, .session-meta { color: #7a8899; font-size: 11px; }
         .session-title { font-weight: 500; }
         .panel-header { font-weight: 600; font-size: 12px; color: #b0bac6; }
         window { background: #0d1117; }",
    );
    if let Some(display) = gtk4::gdk::Display::default() {
        gtk4::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }

    window.present();

    // If there are repos, select the first one for immediate usefulness.
    if !state.borrow().repos.is_empty() {
        if let Some(row) = repo_list.row_at_index(0) {
            repo_list.select_row(Some(&row));
        }
    }
}

fn main() {
    let app = Application::builder()
        .application_id("org.acreetionos.reason")
        .build();
    app.connect_activate(build_ui);
    app.run();
}
