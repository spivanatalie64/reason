/* graph_layout.c — lane assignment for the commit DAG.
 *
 * Port of the layout proven in the browser prototype: walk commits in
 * topological order, keep the first parent in the current lane, and give each
 * additional parent a new lane at the point the merge is seen so branches read
 * top-down in the order they join history.
 *
 * The input is already in topological order (from `git log --topo-order`), so
 * a parent is always at a higher row index than any of its children in this
 * array. */

#include "reason.h"
#include <string.h>
#include <stdlib.h>

int32_t reason_assign_columns(ReasonCommit *commits, int32_t count) {
    if (count <= 0) return 0;

    int32_t *col = (int32_t *)malloc((size_t)count * sizeof(int32_t));
    uint8_t *seen = (uint8_t *)calloc((size_t)count, 1);
    if (!col || !seen) {
        free(col);
        free(seen);
        return 0;
    }
    for (int32_t i = 0; i < count; i++) col[i] = -1;

    int32_t next_column = 0;

    /* Explicit stack of (index, column) pairs for the pre-order walk. */
    int32_t cap = count * 2 + 16;
    int32_t *stack_idx = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
    int32_t *stack_col = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
    int32_t sp = 0;
    if (!stack_idx || !stack_col) {
        free(col); free(seen); free(stack_idx); free(stack_col);
        return 0;
    }

    stack_idx[sp] = 0;
    stack_col[sp] = 0;
    sp++;

    while (sp > 0) {
        sp--;
        int32_t idx = stack_idx[sp];
        int32_t c = stack_col[sp];
        if (idx < 0 || idx >= count) continue;
        if (seen[idx]) continue;
        seen[idx] = 1;
        col[idx] = c;

        ReasonCommit *cm = &commits[idx];
        if (cm->parent_count <= 0) continue;

        /* Build children list: first parent stays in lane, others get new lanes. */
        int32_t first = cm->parents[0];
        int32_t extra = cm->parent_count - 1;

        /* Push in reverse so first parent is processed first (main line keeps
         * its column). */
        for (int32_t i = extra; i >= 1; i--) {
            int32_t p = cm->parents[i];
            int32_t pc = next_column++;
            if (sp < cap) {
                stack_idx[sp] = p;
                stack_col[sp] = pc;
                sp++;
            }
        }
        if (first >= 0 && sp < cap) {
            stack_idx[sp] = first;
            stack_col[sp] = c;
            sp++;
        }
    }

    /* Anything unreachable from the root tip gets placed so it is still visible. */
    for (int32_t i = 0; i < count; i++) {
        if (col[i] < 0) col[i] = next_column++;
        commits[i].column = col[i];
    }

    free(col);
    free(seen);
    free(stack_idx);
    free(stack_col);
    return next_column;
}
