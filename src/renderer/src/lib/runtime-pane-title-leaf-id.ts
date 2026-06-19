import { FIRST_PANE_ID } from '../../../shared/pane-key'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../shared/types'

function getLeftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : getLeftmostLeafId(node.first)
}

function collectReplayCreatedPaneLeafIds(
  node: TerminalPaneLayoutNode,
  leafIdsInReplayCreationOrder: string[]
): void {
  if (node.type === 'leaf') {
    return
  }

  leafIdsInReplayCreationOrder.push(getLeftmostLeafId(node.second))

  if (node.first.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.first, leafIdsInReplayCreationOrder)
  }
  if (node.second.type === 'split') {
    collectReplayCreatedPaneLeafIds(node.second, leafIdsInReplayCreationOrder)
  }
}

function collectLeafIdsInReplayCreationOrder(
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

export function resolveRuntimePaneTitleLeafId(
  tabLayout: { root?: TerminalLayoutSnapshot['root'] } | undefined,
  runtimePaneId: string
): string | null {
  return resolveRuntimePaneTitleLeafIdFromRoot(tabLayout?.root, runtimePaneId)
}

/**
 * Resolve the runtime-reported pane title for a specific layout leaf. Pane
 * title maps are keyed by runtime pane id, which only lines up with the leaf id
 * after replay-order resolution — split tabs can carry a sparse title map, so a
 * lone background title must not be attributed to an unrelated leaf.
 */
export function resolveRuntimePaneTitleForLeaf(
  tabLayout: { root?: TerminalLayoutSnapshot['root'] } | undefined,
  paneTitles: Record<number, string> | undefined,
  leafId: string
): string | null {
  if (!paneTitles) {
    return null
  }

  const titleEntries = Object.entries(paneTitles)
  if (titleEntries.length === 0) {
    return null
  }

  if (tabLayout?.root) {
    for (const [runtimePaneId, title] of titleEntries) {
      if (resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId) === leafId) {
        return title
      }
    }
    return null
  }

  if (titleEntries.length === 1) {
    return titleEntries[0][1]
  }

  for (const [runtimePaneId, title] of titleEntries) {
    if (resolveRuntimePaneTitleLeafId(tabLayout, runtimePaneId) === leafId) {
      return title
    }
  }
  return null
}

export function resolveRuntimePaneTitleLeafIdFromRoot(
  root: TerminalPaneLayoutNode | null | undefined,
  runtimePaneId: string
): string | null {
  if (isTerminalLeafId(runtimePaneId)) {
    return runtimePaneId
  }
  const numericPaneId = Number(runtimePaneId)
  if (!Number.isInteger(numericPaneId) || numericPaneId < FIRST_PANE_ID) {
    return null
  }
  const leafIds = collectLeafIdsInReplayCreationOrder(root)
  return leafIds[numericPaneId - FIRST_PANE_ID] ?? null
}
