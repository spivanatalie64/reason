// build.rs — compile C helpers and link GTK4.
//
// The graph layout and diff parsing hot paths live in C: they are pure data
// transforms over arrays of commits and lines, with no GTK dependency, so C
// keeps them small and easy to test in isolation. Rust owns everything that
// touches GTK, the opencode database, and the network.

fn main() {
    let mut build = cc::Build::new();
    build
        .file("src/c/graph_layout.c")
        .file("src/c/diff_parse.c")
        .flag_if_supported("-O2")
        .flag_if_supported("-Wall");
    build.compile("reason_c");

    println!("cargo:rerun-if-changed=src/c/graph_layout.c");
    println!("cargo:rerun-if-changed=src/c/diff_parse.c");
    println!("cargo:rerun-if-changed=src/c/reason.h");
}
