import type { TestOutlineNode } from './test-case-outline-parse'

/**
 * Collects IDs of all outline nodes that contain child test cases.
 */
export function collectTestOutlineParentIds(items: TestOutlineNode[]): Set<string> {
  const parentIds = new Set<string>()

  function visit(nodes: TestOutlineNode[]): void {
    for (const item of nodes) {
      if (item.children.length > 0) {
        parentIds.add(item.id)
        visit(item.children)
      }
    }
  }

  visit(items)
  return parentIds
}

/**
 * Prunes collapsed node IDs that no longer exist in the current outline tree.
 */
export function pruneTestOutlineCollapsedIds(
  collapsedIds: ReadonlySet<string>,
  items: TestOutlineNode[]
): Set<string> {
  const parentIds = collectTestOutlineParentIds(items)
  const next = new Set<string>()
  for (const id of collapsedIds) {
    if (parentIds.has(id)) {
      next.add(id)
    }
  }
  return next
}

/**
 * Toggles a test outline item's collapsed state.
 */
export function toggleTestOutlineCollapsedId(
  collapsedIds: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(collapsedIds)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

/**
 * Returns whether an outline item is currently expanded in the tree view.
 */
export function isTestOutlineItemExpanded(
  collapsedIds: ReadonlySet<string>,
  item: TestOutlineNode
): boolean {
  return item.children.length === 0 || !collapsedIds.has(item.id)
}
