//! Commit graph model and FFI to the C lane layout.

use crate::git::Commit;
use std::collections::HashMap;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct CCommit {
    pub parents: [i32; 8],
    pub parent_count: i32,
    pub column: i32,
    pub row: i32,
}

extern "C" {
    fn reason_assign_columns(commits: *mut CCommit, count: i32) -> i32;
}

#[derive(Debug, Clone)]
pub struct GraphNode {
    pub commit: Commit,
    pub row: usize,
    pub col: i32,
}

#[derive(Debug, Clone)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub column_count: i32,
}

/// Build a drawable graph from commits in topological order.
pub fn build(commits: Vec<Commit>) -> Graph {
    let count = commits.len();
    if count == 0 {
        return Graph { nodes: Vec::new(), column_count: 0 };
    }

    // Map SHA -> index for resolving parent links within this window.
    let mut index_of: HashMap<&str, i32> = HashMap::with_capacity(count);
    for (i, c) in commits.iter().enumerate() {
        index_of.insert(c.sha.as_str(), i as i32);
    }

    let mut ccommits: Vec<CCommit> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut cc = CCommit::default();
            cc.row = i as i32;
            let mut pc = 0i32;
            for p in &c.parents {
                if pc >= 8 { break; }
                if let Some(&idx) = index_of.get(p.as_str()) {
                    cc.parents[pc as usize] = idx;
                    pc += 1;
                }
            }
            cc.parent_count = pc;
            cc
        })
        .collect();

    let cols = unsafe { reason_assign_columns(ccommits.as_mut_ptr(), count as i32) };

    let nodes = commits
        .into_iter()
        .enumerate()
        .map(|(i, c)| GraphNode {
            col: ccommits[i].column,
            row: i,
            commit: c,
        })
        .collect();

    Graph { nodes, column_count: cols }
}
