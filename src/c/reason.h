/* reason.h — C helpers for the Reason GTK application.
 *
 * The graph layout is pure data: commit SHAs, parent lists, and row/column
 * assignments. Keeping it in C makes the hot loop over thousands of commits
 * cheap and gives Rust a stable FFI boundary for the part that is easiest to
 * test as plain arrays.
 */

#ifndef REASON_H
#define REASON_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* A commit as the layout sees it: parents are indices into the same array,
 * or -1 when the parent is not present in this window of history. */
typedef struct {
    int32_t parents[8];
    int32_t parent_count;
    int32_t column;   /* output */
    int32_t row;      /* output (set by caller) */
} ReasonCommit;

/* Assign a lane (column) to every commit in topological order.
 * Returns the number of columns used. Commits are modified in place. */
int32_t reason_assign_columns(ReasonCommit *commits, int32_t count);

#ifdef __cplusplus
}
#endif

#endif
