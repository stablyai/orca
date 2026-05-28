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

export function normalizeTerminalLayoutSnapshot(
  snapshot: TerminalLayoutSnapshot | null | undefined
): { snapshot: TerminalLayoutSnapshot; changed: boolean } {
  if (!snapshot?.root) {
    return { snapshot: snapshot ?? EMPTY_TERMINAL_LAYOUT, changed: false }
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
  if (!changed) {
    return { snapshot, changed: false }
  }
  const rewrite: LeafIdRewrite = { nextLeafIdByInputLeafId, duplicatedInputLeafIds }
  const root = cloneLayoutWithLeafRewrite(snapshot.root, rewrite)
  const activeLeafId =
    snapshot.activeLeafId && !duplicatedInputLeafIds.has(snapshot.activeLeafId)
      ? (nextLeafIdByInputLeafId.get(snapshot.activeLeafId) ?? null)
      : firstLeafId(root)
  const expandedLeafId =
    snapshot.expandedLeafId && !duplicatedInputLeafIds.has(snapshot.expandedLeafId)
      ? (nextLeafIdByInputLeafId.get(snapshot.expandedLeafId) ?? null)
      : null
  const ptyIdsByLeafId = remapLeafRecord(snapshot.ptyIdsByLeafId, rewrite)
  const buffersByLeafId = remapLeafRecord(snapshot.buffersByLeafId, rewrite)
  const titlesByLeafId = remapLeafRecord(snapshot.titlesByLeafId, rewrite)
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
    titlesByLeafId: _oldTitlesByLeafId,
    ...snapshotWithoutLeafRecords
  } = snapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root,
      activeLeafId,
      expandedLeafId,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
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
