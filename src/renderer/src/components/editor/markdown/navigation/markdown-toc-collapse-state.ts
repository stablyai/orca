import type { MarkdownTocItem, MarkdownTocLevel } from './markdown-table-of-contents'

export function collectMarkdownTocParentIds(items: MarkdownTocItem[]): Set<string> {
  const parentIds = new Set<string>()

  function visit(nodes: MarkdownTocItem[]): void {
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

export function collapseMarkdownTocToLevel(
  items: MarkdownTocItem[],
  maxExpandedLevel: MarkdownTocLevel
): Set<string> {
  const collapsed = new Set<string>()

  function visit(nodes: MarkdownTocItem[]): void {
    for (const item of nodes) {
      if (item.children.length > 0 && item.level >= maxExpandedLevel) {
        collapsed.add(item.id)
      }
      visit(item.children)
    }
  }

  visit(items)
  return collapsed
}

export function pruneMarkdownTocCollapsedIds(
  collapsedIds: ReadonlySet<string>,
  items: MarkdownTocItem[]
): Set<string> {
  const parentIds = collectMarkdownTocParentIds(items)
  const next = new Set<string>()
  for (const id of collapsedIds) {
    if (parentIds.has(id)) {
      next.add(id)
    }
  }
  return next
}

export function toggleMarkdownTocCollapsedId(
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

export function isMarkdownTocItemExpanded(
  collapsedIds: ReadonlySet<string>,
  item: MarkdownTocItem
): boolean {
  return item.children.length === 0 || !collapsedIds.has(item.id)
}
