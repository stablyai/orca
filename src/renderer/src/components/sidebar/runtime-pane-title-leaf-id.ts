import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types'

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
  tabLayout: TerminalLayoutSnapshot | undefined,
  runtimePaneId: string
): string | null {
  return resolveRuntimePaneTitleLeafIdFromRoot(tabLayout?.root, runtimePaneId)
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
