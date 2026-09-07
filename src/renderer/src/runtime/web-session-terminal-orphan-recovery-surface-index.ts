import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { resolveRootlessTerminalLayoutLeafId } from '../components/terminal-pane/terminal-layout-leaf-ids'

export function surfaceKey(tabId: string, leafId: string): string {
  return `${tabId}\0${leafId}`
}

export function isRemovedSnapshot(snapshot: RuntimeMobileSessionTabsResult): boolean {
  return 'removed' in snapshot && snapshot.removed === true
}

export function isValidReadySurface(tab: RuntimeMobileSessionTerminalClientTab): boolean {
  return tab.status === 'ready' && typeof tab.terminal === 'string' && tab.terminal.length > 0
}

export function terminalRowsBySurface(
  snapshot: RuntimeMobileSessionTabsResult
): Map<string, RuntimeMobileSessionTerminalClientTab[]> {
  const rows = new Map<string, RuntimeMobileSessionTerminalClientTab[]>()
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const key = surfaceKey(tab.parentTabId, tab.leafId)
    const existing = rows.get(key) ?? []
    existing.push(tab)
    rows.set(key, existing)
  }
  return rows
}

export type TerminalLayoutLeaf = { leafId: string; offTree: boolean }

export function terminalLayoutLeafIds(
  layout: TerminalLayoutSnapshot | null | undefined
): TerminalLayoutLeaf[] {
  if (!layout) {
    return []
  }
  const treeLeafIds = layout.root ? terminalLayoutTreeLeafIds(layout.root) : []
  const primaryLeafIds = layout.root
    ? treeLeafIds
    : [resolveRootlessTerminalLayoutLeafId(layout)].filter(
        (leafId): leafId is string => leafId !== null
      )
  const primary = primaryLeafIds.map((leafId) => ({ leafId, offTree: false }))
  const treeLeafIdSet = new Set(primaryLeafIds)
  const staleBindings = Object.keys(layout.ptyIdsByLeafId ?? {})
    .filter((leafId) => !treeLeafIdSet.has(leafId))
    .map((leafId) => ({ leafId, offTree: true }))
  return [...primary, ...staleBindings]
}

function terminalLayoutTreeLeafIds(root: TerminalPaneLayoutNode): string[] {
  if (root.type === 'leaf') {
    return [root.leafId]
  }
  return [...terminalLayoutTreeLeafIds(root.first), ...terminalLayoutTreeLeafIds(root.second)]
}
