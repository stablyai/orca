import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PaneManagerHost } from './pane-manager-host'
import type { ManagedPaneInternal } from './pane-manager-types'
import { updateMultiPaneState } from './pane-drag-reorder'
import { detachPaneFromTree, insertPaneNextTo } from './pane-tree-ops'

function leftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : leftmostLeafId(node.first)
}

function leafIdsOf(node: TerminalPaneLayoutNode, into: string[] = []): string[] {
  if (node.type === 'leaf') {
    into.push(node.leafId)
  } else {
    leafIdsOf(node.first, into)
    leafIdsOf(node.second, into)
  }
  return into
}

/**
 * Rearranges the mounted panes into `layout`'s shape by moving their containers, so no terminal is
 * recreated; ratios are left to `applyPaneLayoutGeometry`. False, changing nothing, when the
 * mounted panes are not exactly the layout's leaves. Never reports a layout change: the shape is
 * the host's, not an edit to push back.
 */
export function movePanesToMatchTree(
  host: PaneManagerHost,
  layout: TerminalPaneLayoutNode
): boolean {
  const callbacks = host.getDragCallbacks()
  const paneByLeafId = new Map<string, ManagedPaneInternal>()
  for (const pane of host.panes.values()) {
    paneByLeafId.set(pane.leafId, pane)
  }
  const leafIds = leafIdsOf(layout)
  if (leafIds.length !== paneByLeafId.size || leafIds.some((id) => !paneByLeafId.has(id))) {
    return false
  }
  const pane = (leafId: string): ManagedPaneInternal => paneByLeafId.get(leafId)!
  for (const leafId of leafIds.slice(1)) {
    detachPaneFromTree(pane(leafId), callbacks)
  }
  // Each split's region is held by its leftmost pane; its second side is placed before either side
  // is divided, so the new split wraps the whole region.
  const place = (node: TerminalPaneLayoutNode): void => {
    if (node.type === 'leaf') {
      return
    }
    insertPaneNextTo(
      pane(leftmostLeafId(node.second)),
      pane(leftmostLeafId(node.first)),
      node.direction === 'vertical' ? 'right' : 'bottom',
      callbacks
    )
    place(node.first)
    place(node.second)
  }
  place(layout)
  callbacks.applyPaneOpacity()
  callbacks.applyDividerStyles()
  updateMultiPaneState(callbacks)
  return true
}
