// Commit graph layout.
//
// GitKraken's graph is the centrepiece of the product, so it gets real
// attention. Two things matter:
//
//   * Every commit sits in a stable column that does not shift when an
//     unrelated branch is added to the view.
//   * Edges are individual paths, so they can be coloured, hovered and dimmed.
//
// The ASCII graph that `git log --graph` prints throws away lane identity
// across merges, and its lanes re-flow as the history grows. So we do not use
// it. We take the raw commit list in topological order and work out the
// columns ourselves.

const COLUMN_WIDTH = 22;
const ROW_HEIGHT = 30;
const NODE_RADIUS = 4.5;
const LABEL_WIDTH = 620;

/**
 * Assign a column to every commit.
 *
 * The walk is an explicit stack rather than recursion so that the order is
 * pre-order: when we meet a merge, its side branches are given their column
 * numbers at that point, top-down, before we descend. The result is that a
 * branch's column reflects where it joins the history rather than the order
 * in which we happened to visit it.
 */
export function assignColumns(commits, bySha) {
  const columns = new Map();
  let nextColumn = 0;

  const root = commits[0];
  if (!root) return { columns, columnCount: 0 };

  const stack = [[root.sha, 0]];
  while (stack.length) {
    const [sha, column] = stack.pop();
    if (columns.has(sha)) continue;
    columns.set(sha, column);

    const commit = bySha.get(sha);
    if (!commit) continue;

    const children = [];
    if (commit.parents[0]) children.push([commit.parents[0], column]);
    // Side branches get their column allocated here, at the merge.
    for (let i = 1; i < commit.parents.length; i++) {
      children.push([commit.parents[i], nextColumn++]);
    }

    // Push in reverse so the first parent is popped first: the main line
    // keeps column 0 all the way down, side branches sit to its right.
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  // Commits that HEAD cannot reach — other branch tips — get columns in the
  // order they appear, so they line up to the right of everything else.
  for (const commit of commits) {
    if (!columns.has(commit.sha)) {
      columns.set(commit.sha, nextColumn++);
      const parent = commit.parents[0];
      if (parent && !columns.has(parent)) {
        // Walk the first-parent chain so the branch stays in one column.
        let sha = parent;
        while (sha && !columns.has(sha)) {
          columns.set(sha, columns.get(commit.sha));
          const next = bySha.get(sha);
          sha = next ? next.parents[0] : null;
        }
      }
    }
  }

  return { columns, columnCount: nextColumn };
}

/**
 * Build the drawable graph.
 *
 * Returns nodes with a row and a column, and edges that name both ends so
 * the renderer can colour them per branch.
 */
export function buildGraph(commits) {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const { columns, columnCount } = assignColumns(commits, bySha);

  const rowOf = new Map();
  commits.forEach((commit, row) => rowOf.set(commit.sha, row));

  const nodes = commits.map((commit, row) => ({
    ...commit,
    row,
    col: columns.get(commit.sha) ?? 0,
    refs: commit.refs || [],
  }));

  const edges = [];
  for (const node of nodes) {
    for (const parentSha of node.parents) {
      const parentRow = rowOf.get(parentSha);
      if (parentRow === undefined) continue;
      const parentCol = columns.get(parentSha) ?? node.col;
      edges.push({
        from: node.sha,
        to: parentSha,
        fromRow: node.row,
        toRow: parentRow,
        fromCol: node.col,
        toCol: parentCol,
        merge: node.col !== parentCol,
      });
    }
  }

  return {
    nodes,
    edges,
    columnCount: Math.max(columnCount, 1),
    width: COLUMN_WIDTH * Math.max(columnCount, 1) + 40,
    height: nodes.length * ROW_HEIGHT + 40,
  };
}

const SVG = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Render the graph.
 *
 * `onSelect` is called with the commit node when a node or its label is
 * clicked.
 *
 * The graph is two panes side by side rather than one drawing, because a
 * history with many branches has a wide lane area and the commit subjects
 * are what actually matter. The lanes get their own box, which scrolls
 * sideways if it has to, and the labels get whatever is left over. The two
 * scroll together vertically, so a row always lines up with its subject.
 */
export function renderGraph(container, graph, { onSelect } = {}) {
  container.textContent = '';

  const columns = Math.max(graph.columnCount, 1);
  // A history with many branches would otherwise push the labels off the
  // edge of the pane, so the lanes get narrower as the branch count grows.
  const columnWidth = columns > 16 ? 12 : columns > 10 ? 16 : 22;
  const laneWidth = columnWidth * columns + 30;
  const height = graph.height;

  // These are HTML boxes, not SVG elements: `el` below is namespaced to
  // SVG, so an SVG-namespaced <div> would not lay out at all.
  const lanesBox = document.createElement('div');
  lanesBox.className = 'graph-lanes';
  const labelsBox = document.createElement('div');
  labelsBox.className = 'graph-labels';
  container.appendChild(lanesBox);
  container.appendChild(labelsBox);

  const x = (col) => 20 + col * columnWidth;
  const y = (row) => 20 + row * ROW_HEIGHT;

  const laneSvg = el('svg', {
    class: 'graph-svg graph-svg-lanes',
    width: laneWidth,
    height,
  });
  const labelSvg = el('svg', {
    class: 'graph-svg graph-svg-labels',
    width: '100%',
    height,
  });

  const edgeLayer = el('g', { class: 'graph-edges' });
  const nodeLayer = el('g', { class: 'graph-nodes' });
  const labelLayer = el('g', { class: 'graph-labels-layer' });
  laneSvg.appendChild(edgeLayer);
  laneSvg.appendChild(nodeLayer);
  labelSvg.appendChild(labelLayer);

  // Edges first so the nodes sit on top of them.
  for (const edge of graph.edges) {
    const x1 = x(edge.fromCol);
    const y1 = y(edge.fromRow);
    const x2 = x(edge.toCol);
    const y2 = y(edge.toRow);
    const dy = Math.max(ROW_HEIGHT * 0.55, Math.abs(y2 - y1) / 2);

    edgeLayer.appendChild(
      el('path', {
        d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`,
        class: `graph-edge${edge.merge ? ' graph-edge-merge' : ''}`,
        'data-from': edge.from,
        'data-to': edge.to,
        fill: 'none',
      }),
    );
  }

  for (const node of graph.nodes) {
    const cx = x(node.col);
    const cy = y(node.row);

    const group = el('g', { class: 'graph-node', 'data-sha': node.sha });
    group.appendChild(
      el('circle', {
        cx,
        cy,
        r: NODE_RADIUS,
        class: `graph-dot${node.parents.length > 1 ? ' graph-dot-merge' : ''}`,
      }),
    );

    // Branch and tag tips get a ring so they stand out from plain commits.
    const refs = node.refs || [];
    if (refs.some((r) => !r.remote)) {
      group.appendChild(
        el('circle', { cx, cy, r: NODE_RADIUS + 3, class: 'graph-tip', fill: 'none' }),
      );
    }

    group.addEventListener('click', () => onSelect && onSelect(node));
    nodeLayer.appendChild(group);

    // The label row: ref names, then the subject.
    const label = el('g', { class: 'graph-label' });
    let textX = 10;

    for (const ref of refs.filter((r) => !r.remote)) {
      const text = el('text', { x: textX, y: cy + 4, class: 'graph-ref' });
      text.textContent = ref.short;
      label.appendChild(text);
      textX += ref.short.length * 6.8 + 12;
    }
    for (const ref of refs.filter((r) => r.remote).slice(0, 2)) {
      const text = el('text', { x: textX, y: cy + 4, class: 'graph-ref graph-ref-remote' });
      text.textContent = ref.short;
      label.appendChild(text);
      textX += ref.short.length * 6.8 + 12;
    }

    const subject = el('text', { x: textX, y: cy + 4, class: 'graph-subject' });
    subject.textContent = node.subject || '(no subject)';
    label.appendChild(subject);

    label.addEventListener('click', () => onSelect && onSelect(node));
    labelLayer.appendChild(label);
  }

  lanesBox.appendChild(laneSvg);
  labelsBox.appendChild(labelSvg);

  // The two panes scroll as one.
  let syncing = false;
  const sync = (from, to) => {
    if (syncing) return;
    syncing = true;
    to.scrollTop = from.scrollTop;
    syncing = false;
  };
  lanesBox.addEventListener('scroll', () => sync(lanesBox, labelsBox));
  labelsBox.addEventListener('scroll', () => sync(labelsBox, lanesBox));

  return { laneSvg, labelSvg, laneWidth };
}

/**
 * Highlight the path of one branch.
 *
 * `branchShas` is the set of commits on the branch. An edge is part of that
 * path when both of its ends are on it, which is exactly the set of edges
 * that belong to a single branch line.
 */
export function highlightBranch(svg, branchShas) {
  const set = new Set(branchShas || []);
  svg.querySelectorAll('.graph-edge').forEach((path) => {
    const on = set.has(path.getAttribute('data-from')) && set.has(path.getAttribute('data-to'));
    path.classList.toggle('graph-edge-active', on);
    path.classList.toggle('graph-edge-dim', set.size > 0 && !on);
  });

  svg.querySelectorAll('.graph-node').forEach((node) => {
    const on = set.has(node.getAttribute('data-sha'));
    node.classList.toggle('graph-node-dim', set.size > 0 && !on);
  });
}
