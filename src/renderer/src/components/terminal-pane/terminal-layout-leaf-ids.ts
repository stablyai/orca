import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'
import { isTerminalLeafId, type TerminalLeafId } from '../../../../shared/stable-pane-id'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'

const EMPTY_TERMINAL_LAYOUT: TerminalLayoutSnapshot = {
  root: null,
  activeLeafId: null,
  expandedLeafId: null
}

type LeafIdRewrite = {
  nextLeafIdByInputLeafId: Map<string, TerminalLeafId>
  duplicatedInputLeafIds: Set<string>
}

function cloneLayoutWithLeafRewrite(
  node: TerminalPaneLayoutNode,
  rewrite: LeafIdRewrite
): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    const replacement = rewrite.nextLeafIdByInputLeafId.get(node.leafId) ?? mintStablePaneId()
    return { type: 'leaf', leafId: replacement }
  }
  return {
    ...node,
    first: cloneLayoutWithLeafRewrite(node.first, rewrite),
    second: cloneLayoutWithLeafRewrite(node.second, rewrite)
  }
}

function remapLeafRecord(
  source: Record<string, string> | undefined,
  rewrite: LeafIdRewrite
): Record<string, string> | undefined {
  if (!source) {
    return undefined
  }
  const next: Record<string, string> = {}
  for (const [leafId, value] of Object.entries(source)) {
    if (rewrite.duplicatedInputLeafIds.has(leafId)) {
      continue
    }
    const nextLeafId = rewrite.nextLeafIdByInputLeafId.get(leafId)
    if (nextLeafId) {
      next[nextLeafId] = value
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function collectLeafCounts(
  node: TerminalPaneLayoutNode,
  counts: Map<string, number> = new Map()
): Map<string, number> {
  if (node.type === 'leaf') {
    counts.set(node.leafId, (counts.get(node.leafId) ?? 0) + 1)
    return counts
  }
  collectLeafCounts(node.first, counts)
  collectLeafCounts(node.second, counts)
  return counts
}

function firstLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLeafId(node.first)
}

function hasLeafPtyBinding(
  ptyIdsByLeafId: Record<string, string> | undefined,
  leafId: string
): boolean {
  return ptyIdsByLeafId ? Object.prototype.hasOwnProperty.call(ptyIdsByLeafId, leafId) : false
}

export function resolveRootlessTerminalLayoutLeafId(
  snapshot: Pick<TerminalLayoutSnapshot, 'activeLeafId' | 'ptyIdsByLeafId'>
): string | null {
  if (snapshot.activeLeafId && isTerminalLeafId(snapshot.activeLeafId)) {
    return snapshot.activeLeafId
  }
  const boundLeafIds = Object.keys(snapshot.ptyIdsByLeafId ?? {}).filter(isTerminalLeafId)
  return boundLeafIds.length === 1 ? boundLeafIds[0] : null
}

export function resolveTerminalLayoutActiveLeafId(opts: {
  root: TerminalPaneLayoutNode | null | undefined
  activeLeafId: string | null | undefined
  ptyIdsByLeafId?: Record<string, string>
}): string | null {
  const leafIds = collectLeafIdsInOrder(opts.root)
  if (leafIds.length === 0) {
    return null
  }

  const leafIdSet = new Set(leafIds)
  const activeLeafId = opts.activeLeafId ?? null
  const hasBoundLeaf = leafIds.some((leafId) => hasLeafPtyBinding(opts.ptyIdsByLeafId, leafId))

  if (
    activeLeafId &&
    leafIdSet.has(activeLeafId) &&
    (!hasBoundLeaf || hasLeafPtyBinding(opts.ptyIdsByLeafId, activeLeafId))
  ) {
    return activeLeafId
  }

  if (hasBoundLeaf) {
    return leafIds.find((leafId) => hasLeafPtyBinding(opts.ptyIdsByLeafId, leafId)) ?? null
  }

  return activeLeafId && leafIdSet.has(activeLeafId) ? activeLeafId : leafIds[0]
}

function getRemappedLeafId(
  leafId: string | null | undefined,
  rewrite: LeafIdRewrite
): string | null {
  if (!leafId || rewrite.duplicatedInputLeafIds.has(leafId)) {
    return null
  }
  return rewrite.nextLeafIdByInputLeafId.get(leafId) ?? null
}

export function normalizeTerminalLayoutSnapshot(
  snapshot: TerminalLayoutSnapshot | null | undefined
): { snapshot: TerminalLayoutSnapshot; changed: boolean } {
  if (!snapshot?.root) {
    const nextSnapshot = snapshot ?? EMPTY_TERMINAL_LAYOUT
    const activeLeafId = resolveRootlessTerminalLayoutLeafId(nextSnapshot)
    return {
      snapshot:
        activeLeafId === nextSnapshot.activeLeafId
          ? nextSnapshot
          : { ...nextSnapshot, activeLeafId },
      changed: activeLeafId !== nextSnapshot.activeLeafId
    }
  }
  const counts = collectLeafCounts(snapshot.root)
  const duplicatedInputLeafIds = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([leafId]) => leafId)
  )
  const nextLeafIdByInputLeafId = new Map<string, TerminalLeafId>()
  let changed = false
  for (const [leafId, count] of counts) {
    if (count === 1 && isTerminalLeafId(leafId)) {
      nextLeafIdByInputLeafId.set(leafId, leafId)
      continue
    }
    changed = true
    if (count === 1) {
      nextLeafIdByInputLeafId.set(leafId, mintStablePaneId())
    }
  }
  const inputLeafIds = new Set(counts.keys())
  const activeLeafId = resolveTerminalLayoutActiveLeafId({
    root: snapshot.root,
    activeLeafId: snapshot.activeLeafId,
    ptyIdsByLeafId: snapshot.ptyIdsByLeafId
  })
  const expandedLeafId =
    snapshot.expandedLeafId && inputLeafIds.has(snapshot.expandedLeafId)
      ? snapshot.expandedLeafId
      : null
  const selectionChanged =
    activeLeafId !== snapshot.activeLeafId || expandedLeafId !== snapshot.expandedLeafId
  if (!changed && !selectionChanged) {
    return { snapshot, changed: false }
  }
  const rewrite: LeafIdRewrite = { nextLeafIdByInputLeafId, duplicatedInputLeafIds }
  const root = changed ? cloneLayoutWithLeafRewrite(snapshot.root, rewrite) : snapshot.root
  // Why: split panes can be restored after a leaf was closed elsewhere; stale
  // selection ids must not strand focus on a missing pane.
  const remappedActiveLeafId = getRemappedLeafId(activeLeafId, rewrite) ?? firstLeafId(root)
  const remappedExpandedLeafId = getRemappedLeafId(expandedLeafId, rewrite)
  const ptyIdsByLeafId = remapLeafRecord(snapshot.ptyIdsByLeafId, rewrite)
  const buffersByLeafId = remapLeafRecord(snapshot.buffersByLeafId, rewrite)
  const scrollbackRefsByLeafId = remapLeafRecord(snapshot.scrollbackRefsByLeafId, rewrite)
  const titlesByLeafId = remapLeafRecord(snapshot.titlesByLeafId, rewrite)
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
    scrollbackRefsByLeafId: _oldScrollbackRefsByLeafId,
    titlesByLeafId: _oldTitlesByLeafId,
    ...snapshotWithoutLeafRecords
  } = snapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root,
      activeLeafId: resolveTerminalLayoutActiveLeafId({
        root,
        activeLeafId: remappedActiveLeafId,
        ptyIdsByLeafId
      }),
      expandedLeafId: remappedExpandedLeafId,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    },
    changed: true
  }
}

export function collectLeafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIdsInOrder(node.first), ...collectLeafIdsInOrder(node.second)]
}

export function collectTerminalLayoutLeafIds(
  snapshot: TerminalLayoutSnapshot | null | undefined
): string[] {
  if (!snapshot) {
    return []
  }
  const ids = new Set(collectLeafIdsInOrder(snapshot.root))
  if (snapshot.activeLeafId) {
    ids.add(snapshot.activeLeafId)
  }
  if (snapshot.expandedLeafId) {
    ids.add(snapshot.expandedLeafId)
  }
  for (const record of [
    snapshot.ptyIdsByLeafId,
    snapshot.buffersByLeafId,
    snapshot.scrollbackRefsByLeafId,
    snapshot.titlesByLeafId
  ]) {
    for (const leafId of Object.keys(record ?? {})) {
      ids.add(leafId)
    }
  }
  return [...ids]
}

export function resolvePtyBoundActiveLeafId(args: {
  root: TerminalPaneLayoutNode | null | undefined
  activeLeafId: string | null | undefined
  ptyIdsByLeafId: Record<string, string> | null | undefined
}): string | null {
  if (!args.root) {
    return Object.keys(args.ptyIdsByLeafId ?? {})[0] ?? args.activeLeafId ?? null
  }
  return resolveTerminalLayoutActiveLeafId({
    root: args.root,
    activeLeafId: args.activeLeafId,
    ptyIdsByLeafId: args.ptyIdsByLeafId ?? undefined
  })
}

export function getLeftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first)
}

function collectReplayCreatedPaneLeafIds(
  node: Extract<TerminalPaneLayoutNode, { type: 'split' }>,
  leafIdsInReplayCreationOrder: string[]
): void {
  // Why: replayTerminalLayout() creates one new pane per split and assigns it
  // to the split's second subtree before recursing, so the new pane maps to
  // the leftmost leaf reachable within that second subtree.
  leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second))

  if (node.first.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder)
  }
  if (node.second.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder)
  }
}

export function collectLeafIdsInReplayCreationOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  const leafIdsInReplayCreationOrder = [getLeftmostLeafId(node)]
  if (node.type === 'split') {
    collectReplayCreatedPaneLeafIds(node, leafIdsInReplayCreationOrder)
  }
  return leafIdsInReplayCreationOrder
}
