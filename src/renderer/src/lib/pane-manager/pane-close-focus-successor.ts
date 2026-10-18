import type { ManagedPaneInternal } from './pane-manager-types'
import { findPaneChildren, getSplitDirection } from './pane-tree-equalization'

/**
 * The pane to focus when `closedContainer` leaves its split: the sibling subtree takes over the
 * freed space, so pick its leaf touching the closed pane's edge. Must run before the DOM removal.
 */
export function findClosedPaneSuccessor(
  closedContainer: HTMLElement,
  panes: ReadonlyMap<number, ManagedPaneInternal>
): ManagedPaneInternal | null {
  const parent = closedContainer.parentElement
  if (!parent?.classList.contains('pane-split')) {
    return null
  }
  const children = findPaneChildren(parent)
  const closedIndex = children.indexOf(closedContainer)
  if (closedIndex === -1) {
    return null
  }
  const closedIsFirst = closedIndex === 0
  const axis = getSplitDirection(parent)
  let node: HTMLElement | undefined = closedIsFirst ? children[1] : children[closedIndex - 1]
  while (node?.classList.contains('pane-split')) {
    const nested = findPaneChildren(node)
    // Why: an orthogonal split touches the closed edge with every child; reading order breaks the tie.
    node = getSplitDirection(node) === axis && !closedIsFirst ? nested.at(-1) : nested[0]
  }
  const paneId = Number(node?.dataset.paneId)
  return Number.isFinite(paneId) ? (panes.get(paneId) ?? null) : null
}
