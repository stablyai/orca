import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsResult
} from '../../../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalClientTab } from '../../../../../../shared/runtime-mobile-session-tab-contracts'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'

export function surfaceKey(tabId: string, leafId: string): string {
  return `${tabId}\0${leafId}`
}

export function hasTerminalHandleRetirementProof(
  snapshot: Pick<RuntimeMobileSessionTabsResult, 'retiredTerminalSurfaces'>,
  surface: { tabId: string; leafId: string; handle: string }
): boolean {
  return (
    snapshot.retiredTerminalSurfaces?.some(
      (retired) =>
        retired.parentTabId === surface.tabId &&
        retired.leafId === surface.leafId &&
        retired.terminal === surface.handle
    ) === true
  )
}

/** The host's newest close record for this pane surface; proofs are appended oldest first. */
export function latestTerminalRetirementProof(
  snapshot: Pick<RuntimeMobileSessionTabsResult, 'retiredTerminalSurfaces'>,
  surface: { tabId: string; leafId: string }
): RuntimeMobileSessionRetiredTerminalSurface | null {
  const proofs = snapshot.retiredTerminalSurfaces ?? []
  for (let index = proofs.length - 1; index >= 0; index -= 1) {
    const proof = proofs[index]
    if (proof.parentTabId === surface.tabId && proof.leafId === surface.leafId) {
      return proof
    }
  }
  return null
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
