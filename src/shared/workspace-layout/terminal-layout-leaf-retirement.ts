import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from './terminal-tab-types'
import { collectLeafIds } from './terminal-pane-layout-tree'

function pruneTerminalPane(
  node: TerminalPaneLayoutNode | null,
  retiredLeafIds: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return retiredLeafIds.has(node.leafId) ? null : node
  }
  const first = pruneTerminalPane(node.first, retiredLeafIds)
  const second = pruneTerminalPane(node.second, retiredLeafIds)
  if (first && second) {
    return { ...node, first, second }
  }
  return first ?? second
}

function omitLeafRecords<T>(
  values: Record<string, T> | undefined,
  retiredLeafIds: ReadonlySet<string>
): Record<string, T> | undefined {
  if (!values) {
    return undefined
  }
  const retained = Object.fromEntries(
    Object.entries(values).filter(([leafId]) => !retiredLeafIds.has(leafId))
  )
  return Object.keys(retained).length > 0 ? retained : undefined
}

/** Drops leaves and their per-leaf records; null when no leaf remains. */
export function retireLeavesFromTerminalLayout(
  layout: TerminalLayoutSnapshot,
  retiredLeafIds: ReadonlySet<string>
): TerminalLayoutSnapshot | null {
  const root = pruneTerminalPane(layout.root, retiredLeafIds)
  if (!root) {
    return null
  }
  const retainedLeafIds = collectLeafIds(root)
  const retainedLeafIdSet = new Set(retainedLeafIds)
  const activeLeafId =
    layout.activeLeafId && retainedLeafIdSet.has(layout.activeLeafId)
      ? layout.activeLeafId
      : retainedLeafIds[0]!
  return {
    ...layout,
    root,
    activeLeafId,
    expandedLeafId:
      layout.expandedLeafId && retainedLeafIdSet.has(layout.expandedLeafId)
        ? layout.expandedLeafId
        : null,
    ptyIdsByLeafId: omitLeafRecords(layout.ptyIdsByLeafId, retiredLeafIds),
    buffersByLeafId: omitLeafRecords(layout.buffersByLeafId, retiredLeafIds),
    scrollbackRefsByLeafId: omitLeafRecords(layout.scrollbackRefsByLeafId, retiredLeafIds),
    titlesByLeafId: omitLeafRecords(layout.titlesByLeafId, retiredLeafIds)
  }
}
