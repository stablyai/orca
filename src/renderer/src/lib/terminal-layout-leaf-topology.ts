import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

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

function sameLeafIdSet(a: Set<string> | null, b: Set<string> | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  if (a.size !== b.size) {
    return false
  }
  for (const leafId of a) {
    if (!b.has(leafId)) {
      return false
    }
  }
  return true
}

/** Cheap change counter for each tab's leaf id SET; ratio/direction/ptyId/scrollback don't bump it. */
export function createTerminalLayoutTopologySignature(): {
  project: (terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>) => number
} {
  let previousSource: Record<string, TerminalLayoutSnapshot> | null = null
  let previousLeafIdsByTabId = new Map<string, Set<string> | null>()
  let signature = 0
  return {
    project(terminalLayoutsByTabId) {
      if (terminalLayoutsByTabId === previousSource) {
        return signature
      }
      const nextLeafIdsByTabId = new Map<string, Set<string> | null>()
      let changed = previousLeafIdsByTabId.size !== Object.keys(terminalLayoutsByTabId).length
      for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
        const leafIds = collectTerminalLayoutLeafIds(layout)
        if (
          !previousLeafIdsByTabId.has(tabId) ||
          !sameLeafIdSet(previousLeafIdsByTabId.get(tabId) ?? null, leafIds)
        ) {
          changed = true
        }
        nextLeafIdsByTabId.set(tabId, leafIds)
      }
      previousSource = terminalLayoutsByTabId
      previousLeafIdsByTabId = nextLeafIdsByTabId
      if (changed) {
        signature += 1
      }
      return signature
    }
  }
}
