import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { terminalLayoutNodeEqual } from './terminal-layout-equality'

/** Collects every leaf id in a layout's pane tree; `null` means the layout hasn't hydrated yet. */
export function collectTerminalLayoutLeafIds(
  layout: TerminalLayoutSnapshot | undefined
): Set<string> | null {
  if (!layout) {
    // Why null, not empty: an unhydrated layout must read as "unknown", so
    // pruning never evicts a retained row on missing evidence alone.
    return null
  }
  const leafIds = new Set<string>()
  const visit = (node: TerminalLayoutSnapshot['root']): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      leafIds.add(node.leafId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout.root)
  return leafIds
}

/** Cheap change counter for tab leaf topology; ptyId/scrollback-only layout writes don't bump it. */
export function createTerminalLayoutTopologySignature(): {
  project: (terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>) => number
} {
  let previousSource: Record<string, TerminalLayoutSnapshot> | null = null
  let previousRootsByTabId = new Map<string, TerminalPaneLayoutNode | null | undefined>()
  let signature = 0
  return {
    project(terminalLayoutsByTabId) {
      if (terminalLayoutsByTabId === previousSource) {
        return signature
      }
      const nextRootsByTabId = new Map<string, TerminalPaneLayoutNode | null | undefined>()
      let changed = previousRootsByTabId.size !== Object.keys(terminalLayoutsByTabId).length
      for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
        const root = layout?.root
        if (
          !previousRootsByTabId.has(tabId) ||
          !terminalLayoutNodeEqual(previousRootsByTabId.get(tabId), root)
        ) {
          changed = true
        }
        nextRootsByTabId.set(tabId, root)
      }
      previousSource = terminalLayoutsByTabId
      previousRootsByTabId = nextRootsByTabId
      if (changed) {
        signature += 1
      }
      return signature
    }
  }
}
