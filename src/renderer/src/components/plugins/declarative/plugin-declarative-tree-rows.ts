import type { PluginDeclarativeTreeItem } from '../../../../../shared/plugins/declarative/plugin-declarative-data-props'

/** One drawn line of a Tree: an item, or the loading line under an expanded lazy item. */
export type PluginDeclarativeTreeRow =
  | {
      kind: 'item'
      item: PluginDeclarativeTreeItem
      level: number
      parent: string | null
      expandable: boolean
      expanded: boolean
    }
  | { kind: 'loading'; key: string; level: number }

/** The visible rows in order: children only under expanded items. Iterative for deep trees. */
export function visibleTreeRows(
  items: readonly PluginDeclarativeTreeItem[],
  expanded: ReadonlySet<string>
): PluginDeclarativeTreeRow[] {
  const rows: PluginDeclarativeTreeRow[] = []
  const stack: { item: PluginDeclarativeTreeItem; level: number; parent: string | null }[] = items
    .map((item) => ({ item, level: 1, parent: null }))
    .toReversed()
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { item, level, parent } = next
    const expandable = item.hasChildren === true || (item.children?.length ?? 0) > 0
    const isExpanded = expandable && expanded.has(item.key)
    rows.push({ kind: 'item', item, level, parent, expandable, expanded: isExpanded })
    if (!isExpanded) {
      continue
    }
    if (!item.children) {
      rows.push({ kind: 'loading', key: `${item.key}#loading`, level: level + 1 })
      continue
    }
    for (let index = item.children.length - 1; index >= 0; index--) {
      stack.push({ item: item.children[index], level: level + 1, parent: item.key })
    }
  }
  return rows
}
