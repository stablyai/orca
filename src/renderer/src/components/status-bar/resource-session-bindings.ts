import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import type { DaemonSession } from './resource-usage-merge-types'

export type ResourceSessionBindingInputs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  workspaceSessionReady: boolean
}

export type ResourceSessionBindingOrigin = {
  tabId: string
  worktreeId: string | null
  leafId: string | null
  source: 'live' | 'tab-wake' | 'layout-wake'
}

export type ResourceSessionBindingIndex = {
  ptyIdToTabId: Map<string, string>
  tabIdToWorktreeId: Map<string, string>
  boundPtyIds: Set<string>
  originByPtyId: Map<string, ResourceSessionBindingOrigin>
}

function addBinding(
  ptyIdToTabId: Map<string, string>,
  originByPtyId: Map<string, ResourceSessionBindingOrigin>,
  tabIdToWorktreeId: Map<string, string>,
  tabId: string,
  ptyId: string | null | undefined,
  source: ResourceSessionBindingOrigin['source'],
  leafId: string | null = null
): void {
  if (!ptyId || ptyIdToTabId.has(ptyId)) {
    return
  }
  ptyIdToTabId.set(ptyId, tabId)
  originByPtyId.set(ptyId, {
    tabId,
    worktreeId: tabIdToWorktreeId.get(tabId) ?? null,
    leafId,
    source
  })
}

export function buildResourceSessionBindingIndex(
  inputs: ResourceSessionBindingInputs
): ResourceSessionBindingIndex {
  const ptyIdToTabId = new Map<string, string>()
  const tabIdToWorktreeId = new Map<string, string>()
  const originByPtyId = new Map<string, ResourceSessionBindingOrigin>()

  for (const [worktreeId, tabs] of Object.entries(inputs.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }

  for (const [tabId, ptyIds] of Object.entries(inputs.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      addBinding(ptyIdToTabId, originByPtyId, tabIdToWorktreeId, tabId, ptyId, 'live')
    }
  }

  // Why: startup-deferred reattach intentionally leaves inactive tabs out of
  // ptyIdsByTabId, but their daemon sessions are still owned by tab/layout
  // wake hints. Resource Manager should not classify those as orphans.
  for (const tabs of Object.values(inputs.tabsByWorktree)) {
    for (const tab of tabs) {
      addBinding(ptyIdToTabId, originByPtyId, tabIdToWorktreeId, tab.id, tab.ptyId, 'tab-wake')
    }
  }

  for (const [tabId, layout] of Object.entries(inputs.terminalLayoutsByTabId ?? {})) {
    if (!tabIdToWorktreeId.has(tabId)) {
      continue
    }
    for (const [leafId, ptyId] of Object.entries(layout.ptyIdsByLeafId ?? {})) {
      addBinding(
        ptyIdToTabId,
        originByPtyId,
        tabIdToWorktreeId,
        tabId,
        ptyId,
        'layout-wake',
        leafId
      )
    }
  }

  return {
    ptyIdToTabId,
    tabIdToWorktreeId,
    boundPtyIds: inputs.workspaceSessionReady ? new Set(ptyIdToTabId.keys()) : new Set(),
    originByPtyId
  }
}

export function countUnboundDaemonSessions(
  sessions: readonly DaemonSession[],
  inputs: ResourceSessionBindingInputs
): number {
  if (!inputs.workspaceSessionReady) {
    return 0
  }
  const { boundPtyIds } = buildResourceSessionBindingIndex(inputs)
  let count = 0
  for (const session of sessions) {
    if (!boundPtyIds.has(session.id)) {
      count += 1
    }
  }
  return count
}
