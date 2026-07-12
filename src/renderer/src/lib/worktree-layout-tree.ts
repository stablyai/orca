import type { WorktreeLayoutNode, WorktreeSplitDirection } from '../../../shared/types'

// Pure, immutable operations over the worktree-level layout tree (leaves are
// worktrees). Mirrors the tab-group split tree but at the worktree level, kept
// side-effect-free so the workbench-views slice and hydration can share and
// unit-test them. A single-leaf tree is the N=1 case (today's workbench).

/** Path from the root to a node, as the sequence of child slots taken. */
export type WorktreeLayoutPath = ('first' | 'second')[]

/** Where a newly-inserted sibling goes relative to the split leaf. */
export type WorktreeSplitPlacement = 'before' | 'after'

/** Min/max flex ratio for a split's first child — matches the tab-group split
 *  handle clamp (TabGroupSplitLayout MIN_RATIO/MAX_RATIO) so worktree-level and
 *  tab-level resizing feel identical. */
export const WORKTREE_SPLIT_MIN_RATIO = 0.15
export const WORKTREE_SPLIT_MAX_RATIO = 0.85

export function clampWorktreeSplitRatio(ratio: number): number {
  if (Number.isNaN(ratio)) {
    return 0.5
  }
  return Math.min(WORKTREE_SPLIT_MAX_RATIO, Math.max(WORKTREE_SPLIT_MIN_RATIO, ratio))
}

export function makeWorktreeLeaf(worktreeId: string): WorktreeLayoutNode {
  return { type: 'leaf', worktreeId }
}

/** Choose the split direction that divides a pane's longer axis so both halves
 *  stay as usable as possible: a wide (or square) pane splits left/right
 *  ('horizontal' → new pane to the right); a tall pane splits top/bottom
 *  ('vertical' → new pane below). Drives the modifier-click "open in parallel"
 *  trigger and the drag-drop default. */
export function pickSplitDirection(size: {
  width: number
  height: number
}): WorktreeSplitDirection {
  return size.width >= size.height ? 'horizontal' : 'vertical'
}

export function collectLeafWorktreeIds(node: WorktreeLayoutNode): string[] {
  if (node.type === 'leaf') {
    return [node.worktreeId]
  }
  return [...collectLeafWorktreeIds(node.first), ...collectLeafWorktreeIds(node.second)]
}

export function leafCount(node: WorktreeLayoutNode): number {
  return node.type === 'leaf' ? 1 : leafCount(node.first) + leafCount(node.second)
}

export function hasLeaf(node: WorktreeLayoutNode, worktreeId: string): boolean {
  if (node.type === 'leaf') {
    return node.worktreeId === worktreeId
  }
  return hasLeaf(node.first, worktreeId) || hasLeaf(node.second, worktreeId)
}

/** Path to the leaf holding `worktreeId`, or null if absent. */
export function findLeafPath(
  node: WorktreeLayoutNode,
  worktreeId: string,
  base: WorktreeLayoutPath = []
): WorktreeLayoutPath | null {
  if (node.type === 'leaf') {
    return node.worktreeId === worktreeId ? base : null
  }
  return (
    findLeafPath(node.first, worktreeId, [...base, 'first']) ??
    findLeafPath(node.second, worktreeId, [...base, 'second'])
  )
}

export function getNodeAtPath(
  node: WorktreeLayoutNode,
  path: WorktreeLayoutPath
): WorktreeLayoutNode | null {
  let current: WorktreeLayoutNode = node
  for (const step of path) {
    if (current.type !== 'split') {
      return null
    }
    current = current[step]
  }
  return current
}

function replaceNodeAtPath(
  node: WorktreeLayoutNode,
  path: WorktreeLayoutPath,
  replacement: WorktreeLayoutNode
): WorktreeLayoutNode {
  if (path.length === 0) {
    return replacement
  }
  if (node.type !== 'split') {
    return node
  }
  const [head, ...rest] = path
  const updatedChild = replaceNodeAtPath(node[head], rest, replacement)
  return head === 'first' ? { ...node, first: updatedChild } : { ...node, second: updatedChild }
}

/** Split the leaf at `path` in two, inserting `newWorktreeId` as its sibling.
 *  No-op (returns the original node) when `newWorktreeId` is already present or
 *  `path` is not a leaf: a worktree surface is a DOM singleton and must never
 *  appear in two panes at once. */
export function splitLeafAtPath(
  node: WorktreeLayoutNode,
  path: WorktreeLayoutPath,
  direction: WorktreeSplitDirection,
  newWorktreeId: string,
  placement: WorktreeSplitPlacement = 'after'
): WorktreeLayoutNode {
  if (hasLeaf(node, newWorktreeId)) {
    return node
  }
  const target = getNodeAtPath(node, path)
  if (!target || target.type !== 'leaf') {
    return node
  }
  const newLeaf = makeWorktreeLeaf(newWorktreeId)
  const split: WorktreeLayoutNode = {
    type: 'split',
    direction,
    first: placement === 'before' ? newLeaf : target,
    second: placement === 'before' ? target : newLeaf,
    ratio: 0.5
  }
  return replaceNodeAtPath(node, path, split)
}

/** Convenience: split the leaf currently showing `targetWorktreeId`. */
export function splitLeafByWorktreeId(
  node: WorktreeLayoutNode,
  targetWorktreeId: string,
  direction: WorktreeSplitDirection,
  newWorktreeId: string,
  placement: WorktreeSplitPlacement = 'after'
): WorktreeLayoutNode {
  const path = findLeafPath(node, targetWorktreeId)
  if (!path) {
    return node
  }
  return splitLeafAtPath(node, path, direction, newWorktreeId, placement)
}

/** Remove the leaf for `worktreeId`, collapsing its parent split so the sibling
 *  absorbs the freed space. Returns null when the removed leaf was the last one. */
export function removeLeaf(
  node: WorktreeLayoutNode,
  worktreeId: string
): WorktreeLayoutNode | null {
  if (node.type === 'leaf') {
    return node.worktreeId === worktreeId ? null : node
  }
  const first = removeLeaf(node.first, worktreeId)
  const second = removeLeaf(node.second, worktreeId)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  if (first === node.first && second === node.second) {
    return node
  }
  return { ...node, first, second }
}

/** Retarget the pane showing `oldWorktreeId` to `newWorktreeId`. No-op if
 *  `newWorktreeId` is already visible elsewhere (avoids a duplicate pane) or
 *  `oldWorktreeId` is absent. */
export function replaceLeaf(
  node: WorktreeLayoutNode,
  oldWorktreeId: string,
  newWorktreeId: string
): WorktreeLayoutNode {
  if (
    oldWorktreeId === newWorktreeId ||
    hasLeaf(node, newWorktreeId) ||
    !hasLeaf(node, oldWorktreeId)
  ) {
    return node
  }
  const map = (n: WorktreeLayoutNode): WorktreeLayoutNode => {
    if (n.type === 'leaf') {
      return n.worktreeId === oldWorktreeId ? makeWorktreeLeaf(newWorktreeId) : n
    }
    return { ...n, first: map(n.first), second: map(n.second) }
  }
  return map(node)
}

/** Set the ratio of the split node at `path` (clamped). No-op if `path` does
 *  not resolve to a split node. */
export function setRatioAtPath(
  node: WorktreeLayoutNode,
  path: WorktreeLayoutPath,
  ratio: number
): WorktreeLayoutNode {
  const target = getNodeAtPath(node, path)
  if (!target || target.type !== 'split') {
    return node
  }
  return replaceNodeAtPath(node, path, { ...target, ratio: clampWorktreeSplitRatio(ratio) })
}

/** Flip every split's direction (horizontal <-> vertical) so a side-by-side
 *  parallel layout becomes stacked and vice-versa. Leaves are untouched. */
export function flipAllSplitDirections(node: WorktreeLayoutNode): WorktreeLayoutNode {
  if (node.type === 'leaf') {
    return node
  }
  return {
    ...node,
    direction: node.direction === 'horizontal' ? 'vertical' : 'horizontal',
    first: flipAllSplitDirections(node.first),
    second: flipAllSplitDirections(node.second)
  }
}

/** Flip the direction of only the split that directly contains `worktreeId`'s
 *  pane, leaving sibling splits alone — so a 3+ pane layout can mix orientations
 *  (e.g. two panes stacked beside a third). No-op if the pane is the root leaf. */
export function toggleParentSplitDirection(
  node: WorktreeLayoutNode,
  worktreeId: string
): WorktreeLayoutNode {
  const path = findLeafPath(node, worktreeId)
  if (!path || path.length === 0) {
    return node
  }
  const parentPath = path.slice(0, -1)
  const parent = getNodeAtPath(node, parentPath)
  if (!parent || parent.type !== 'split') {
    return node
  }
  return replaceNodeAtPath(node, parentPath, {
    ...parent,
    direction: parent.direction === 'horizontal' ? 'vertical' : 'horizontal'
  })
}

/** Drop any leaf whose worktree is not in `validWorktreeIds`, collapsing splits.
 *  Returns null when nothing survives (used by session hydration to prune
 *  worktrees that no longer exist). */
export function pruneLeaves(
  node: WorktreeLayoutNode,
  validWorktreeIds: ReadonlySet<string>
): WorktreeLayoutNode | null {
  if (node.type === 'leaf') {
    return validWorktreeIds.has(node.worktreeId) ? node : null
  }
  const first = pruneLeaves(node.first, validWorktreeIds)
  const second = pruneLeaves(node.second, validWorktreeIds)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  if (first === node.first && second === node.second) {
    return node
  }
  return { ...node, first, second }
}
