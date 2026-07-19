import type { TabGroupSplitDirection, WorkspacePaneNode } from '../../../../shared/types'

/** Hard ceiling on visible worktree panes — each pane streams live PTY bytes
 *  and runs its own git poll, so an unbounded tree would melt slow hosts. */
export const MAX_WORKSPACE_SPLIT_PANES = 6

export const WORKSPACE_SPLIT_MIN_RATIO = 0.2
export const WORKSPACE_SPLIT_MAX_RATIO = 0.8

export type WorkspacePaneOpenEdge = 'left' | 'right' | 'up' | 'down' | 'replace'

/** The split-view store fields, structurally typed so pure helpers can
 *  take either the full AppState or a test fixture. */
export type WorkspaceSplitStateFields = {
  workspaceSplitLayout: WorkspacePaneNode | null
  workspaceSplitLayoutsByAnchor: Record<string, WorkspacePaneNode>
  activeWorkspaceSplitAnchorId: string | null
  workspaceSplitAnchorMru: string[]
  workspaceSplitMaximizedPaneId: string | null
}

export function collectPaneIds(node: WorkspacePaneNode): string[] {
  if (node.type === 'pane') {
    return [node.worktreeId]
  }
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)]
}

export function workspaceSplitContainsPane(
  node: WorkspacePaneNode | null,
  worktreeId: string
): boolean {
  if (!node) {
    return false
  }
  return collectPaneIds(node).includes(worktreeId)
}

/** Swap one leaf's worktree for another (center-drop "replace this pane"). */
export function replaceWorkspacePaneLeaf(
  node: WorkspacePaneNode,
  fromWorktreeId: string,
  toWorktreeId: string
): WorkspacePaneNode {
  if (node.type === 'pane') {
    return node.worktreeId === fromWorktreeId ? { type: 'pane', worktreeId: toWorktreeId } : node
  }
  return {
    ...node,
    first: replaceWorkspacePaneLeaf(node.first, fromWorktreeId, toWorktreeId),
    second: replaceWorkspacePaneLeaf(node.second, fromWorktreeId, toWorktreeId)
  }
}

function edgeToSplit(edge: Exclude<WorkspacePaneOpenEdge, 'replace'>): {
  direction: TabGroupSplitDirection
  newFirst: boolean
} {
  // horizontal = side-by-side columns, matching TabGroupLayoutNode semantics.
  switch (edge) {
    case 'left':
      return { direction: 'horizontal', newFirst: true }
    case 'right':
      return { direction: 'horizontal', newFirst: false }
    case 'up':
      return { direction: 'vertical', newFirst: true }
    case 'down':
      return { direction: 'vertical', newFirst: false }
  }
}

export function splitWorkspacePaneLeaf(
  node: WorkspacePaneNode,
  targetWorktreeId: string,
  newWorktreeId: string,
  edge: Exclude<WorkspacePaneOpenEdge, 'replace'>
): WorkspacePaneNode {
  if (node.type === 'pane') {
    if (node.worktreeId !== targetWorktreeId) {
      return node
    }
    const { direction, newFirst } = edgeToSplit(edge)
    const newPane: WorkspacePaneNode = { type: 'pane', worktreeId: newWorktreeId }
    return {
      type: 'split',
      direction,
      first: newFirst ? newPane : node,
      second: newFirst ? node : newPane,
      ratio: 0.5
    }
  }
  return {
    ...node,
    first: splitWorkspacePaneLeaf(node.first, targetWorktreeId, newWorktreeId, edge),
    second: splitWorkspacePaneLeaf(node.second, targetWorktreeId, newWorktreeId, edge)
  }
}

export function removeWorkspacePaneLeaves(
  node: WorkspacePaneNode,
  worktreeIds: ReadonlySet<string>
): WorkspacePaneNode | null {
  if (node.type === 'pane') {
    return worktreeIds.has(node.worktreeId) ? null : node
  }
  const first = removeWorkspacePaneLeaves(node.first, worktreeIds)
  const second = removeWorkspacePaneLeaves(node.second, worktreeIds)
  if (first && second) {
    return first === node.first && second === node.second ? node : { ...node, first, second }
  }
  return first ?? second
}

export function clampWorkspaceSplitRatio(ratio: number): number {
  return Math.min(WORKSPACE_SPLIT_MAX_RATIO, Math.max(WORKSPACE_SPLIT_MIN_RATIO, ratio))
}

export function updateWorkspaceSplitRatioAtPath(
  node: WorkspacePaneNode,
  path: readonly ('first' | 'second')[],
  ratio: number
): WorkspacePaneNode {
  if (node.type !== 'split') {
    return node
  }
  if (path.length === 0) {
    return node.ratio === ratio ? node : { ...node, ratio }
  }
  const [head, ...rest] = path
  const child = updateWorkspaceSplitRatioAtPath(node[head], rest, ratio)
  return child === node[head] ? node : { ...node, [head]: child }
}

/** Drop leaves for removed worktrees; collapses to null below 2 leaves.
 *  Returns the same reference when nothing changed (Zustand no-op safe). */
export function pruneWorkspaceSplitLayout(
  layout: WorkspacePaneNode | null,
  removedWorktreeIds: ReadonlySet<string>
): WorkspacePaneNode | null {
  if (!layout || removedWorktreeIds.size === 0) {
    return layout
  }
  if (!collectPaneIds(layout).some((id) => removedWorktreeIds.has(id))) {
    return layout
  }
  const next = removeWorkspacePaneLeaves(layout, removedWorktreeIds)
  return next && next.type === 'split' ? next : null
}

/** The saved split (anchor id) a worktree belongs to, most recently shown
 *  first. The active split wins outright when it contains the worktree. */
export function findWorkspaceSplitAnchorForWorktree(
  state: WorkspaceSplitStateFields,
  worktreeId: string
): string | null {
  if (
    state.activeWorkspaceSplitAnchorId &&
    workspaceSplitContainsPane(state.workspaceSplitLayout, worktreeId)
  ) {
    return state.activeWorkspaceSplitAnchorId
  }
  const orderedAnchors = [
    ...state.workspaceSplitAnchorMru,
    ...Object.keys(state.workspaceSplitLayoutsByAnchor)
  ]
  const seen = new Set<string>()
  for (const anchorId of orderedAnchors) {
    if (seen.has(anchorId)) {
      continue
    }
    seen.add(anchorId)
    const layout = state.workspaceSplitLayoutsByAnchor[anchorId]
    if (layout && workspaceSplitContainsPane(layout, worktreeId)) {
      return anchorId
    }
  }
  return null
}

export function bumpWorkspaceSplitAnchorMru(mru: readonly string[], anchorId: string): string[] {
  return [anchorId, ...mru.filter((id) => id !== anchorId)]
}

/** A project lives in at most one saved split. Removes the given worktrees
 *  from every split except keepAnchorId — dragging a project into a new
 *  pairing steals it from its old one, which dissolves below 2 leaves. */
export function removeWorktreesFromOtherWorkspaceSplits(
  byAnchor: Record<string, WorkspacePaneNode>,
  mru: readonly string[],
  keepAnchorId: string,
  worktreeIds: readonly string[]
): { byAnchor: Record<string, WorkspacePaneNode>; mru: string[] } {
  const removed = new Set(worktreeIds)
  const nextByAnchor: Record<string, WorkspacePaneNode> = {}
  for (const [anchorId, layout] of Object.entries(byAnchor)) {
    if (anchorId === keepAnchorId) {
      nextByAnchor[anchorId] = layout
      continue
    }
    const pruned = pruneWorkspaceSplitLayout(layout, removed)
    if (pruned) {
      nextByAnchor[anchorId] = pruned
    }
  }
  return { byAnchor: nextByAnchor, mru: mru.filter((anchorId) => nextByAnchor[anchorId]) }
}

/** An anchor key must reference a member of its own layout — otherwise a
 *  later split minted under that worktree's id would silently overwrite an
 *  unrelated association. Re-keys stale entries to their first leaf (which,
 *  under exclusive membership, can never collide with another live key). */
export function normalizeWorkspaceSplitAnchorKeys(state: {
  byAnchor: Record<string, WorkspacePaneNode>
  mru: readonly string[]
  activeAnchorId: string | null
}): { byAnchor: Record<string, WorkspacePaneNode>; mru: string[]; activeAnchorId: string | null } {
  const keyMap = new Map<string, string>()
  const nextByAnchor: Record<string, WorkspacePaneNode> = {}
  for (const [anchorId, layout] of Object.entries(state.byAnchor)) {
    const leaves = collectPaneIds(layout)
    const nextKey = leaves.includes(anchorId) ? anchorId : (leaves[0] ?? anchorId)
    // On the impossible collision (exclusivity violated), keep the old key
    // rather than clobbering another entry.
    const finalKey = nextKey !== anchorId && nextByAnchor[nextKey] ? anchorId : nextKey
    keyMap.set(anchorId, finalKey)
    nextByAnchor[finalKey] = layout
  }
  const seen = new Set<string>()
  const nextMru: string[] = []
  for (const anchorId of state.mru) {
    const mapped = keyMap.get(anchorId)
    if (mapped && nextByAnchor[mapped] && !seen.has(mapped)) {
      seen.add(mapped)
      nextMru.push(mapped)
    }
  }
  return {
    byAnchor: nextByAnchor,
    mru: nextMru,
    activeAnchorId: state.activeAnchorId ? (keyMap.get(state.activeAnchorId) ?? null) : null
  }
}

/** Hydration sweep for sessions written before exclusive membership: keeps
 *  each worktree's most recently shown split and prunes it from the rest. */
export function enforceExclusiveWorkspaceSplitMembership(
  byAnchor: Record<string, WorkspacePaneNode>,
  mru: readonly string[]
): { byAnchor: Record<string, WorkspacePaneNode>; mru: string[] } {
  const seen = new Set<string>()
  const orderedAnchors: string[] = []
  for (const anchorId of [...mru, ...Object.keys(byAnchor)]) {
    if (!seen.has(anchorId) && byAnchor[anchorId]) {
      seen.add(anchorId)
      orderedAnchors.push(anchorId)
    }
  }
  const claimed = new Set<string>()
  const nextByAnchor: Record<string, WorkspacePaneNode> = {}
  for (const anchorId of orderedAnchors) {
    const layout = byAnchor[anchorId]
    const stolen = new Set(collectPaneIds(layout).filter((paneId) => claimed.has(paneId)))
    const pruned = pruneWorkspaceSplitLayout(layout, stolen)
    if (!pruned) {
      continue
    }
    for (const paneId of collectPaneIds(pruned)) {
      claimed.add(paneId)
    }
    nextByAnchor[anchorId] = pruned
  }
  return { byAnchor: nextByAnchor, mru: mru.filter((anchorId) => nextByAnchor[anchorId]) }
}

/** Prune removed worktrees from the active split AND every saved split.
 *  Always returns ONLY the four split fields (never the input state object)
 *  so callers can spread it into a wider store patch safely; per-field
 *  references are preserved when untouched. */
export function pruneWorkspaceSplitState(
  state: Partial<WorkspaceSplitStateFields>,
  removedWorktreeIds: ReadonlySet<string>
): WorkspaceSplitStateFields {
  // Why: buildWorktreePurgeState's contract tolerates partial state — some
  // worktree-isolation test callers construct stores without this slice.
  const currentLayout = state.workspaceSplitLayout ?? null
  const currentByAnchor = state.workspaceSplitLayoutsByAnchor ?? {}
  const currentAnchorId = state.activeWorkspaceSplitAnchorId ?? null
  const currentMru = state.workspaceSplitAnchorMru ?? []
  const currentMaximized = state.workspaceSplitMaximizedPaneId ?? null
  const unchanged: WorkspaceSplitStateFields = {
    workspaceSplitLayout: currentLayout,
    workspaceSplitLayoutsByAnchor: currentByAnchor,
    activeWorkspaceSplitAnchorId: currentAnchorId,
    workspaceSplitAnchorMru: currentMru,
    workspaceSplitMaximizedPaneId: currentMaximized
  }
  if (removedWorktreeIds.size === 0) {
    return unchanged
  }
  let mapChanged = false
  const nextByAnchor: Record<string, WorkspacePaneNode> = {}
  for (const [anchorId, layout] of Object.entries(currentByAnchor)) {
    const pruned = pruneWorkspaceSplitLayout(layout, removedWorktreeIds)
    if (pruned === layout) {
      nextByAnchor[anchorId] = layout
      continue
    }
    mapChanged = true
    if (pruned) {
      nextByAnchor[anchorId] = pruned
    }
  }
  const activeLayoutPruned = pruneWorkspaceSplitLayout(currentLayout, removedWorktreeIds)
  if (!mapChanged && activeLayoutPruned === currentLayout) {
    return unchanged
  }
  const nextMru = currentMru.filter((anchorId) => nextByAnchor[anchorId])
  const activeAnchorSurvives =
    currentAnchorId !== null &&
    Boolean(nextByAnchor[currentAnchorId]) &&
    activeLayoutPruned !== null
  const maximizedSurvives =
    activeAnchorSurvives && currentMaximized !== null && !removedWorktreeIds.has(currentMaximized)
  const normalized = normalizeWorkspaceSplitAnchorKeys({
    byAnchor: nextByAnchor,
    mru: nextMru,
    activeAnchorId: activeAnchorSurvives ? currentAnchorId : null
  })
  return {
    workspaceSplitLayout: activeAnchorSurvives ? activeLayoutPruned : null,
    workspaceSplitLayoutsByAnchor: normalized.byAnchor,
    activeWorkspaceSplitAnchorId: normalized.activeAnchorId,
    workspaceSplitAnchorMru: normalized.mru,
    workspaceSplitMaximizedPaneId: maximizedSurvives ? currentMaximized : null
  }
}
