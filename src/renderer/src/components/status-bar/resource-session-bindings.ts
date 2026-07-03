import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import type { DaemonSession } from './resource-usage-merge-types'

export type ResourceSessionBindingInputs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  workspaceSessionReady: boolean
}

export type ResourceSessionBindingIndex = {
  ptyIdToTabId: Map<string, string>
  tabIdToWorktreeId: Map<string, string>
  boundPtyIds: Set<string>
}

function addBinding(
  ptyIdToTabId: Map<string, string>,
  tabId: string,
  ptyId: string | null | undefined
): void {
  if (!ptyId || ptyIdToTabId.has(ptyId)) {
    return
  }
  ptyIdToTabId.set(ptyId, tabId)
}

export function buildResourceSessionBindingIndex(
  inputs: ResourceSessionBindingInputs
): ResourceSessionBindingIndex {
  const ptyIdToTabId = new Map<string, string>()
  const tabIdToWorktreeId = new Map<string, string>()

  for (const [worktreeId, tabs] of Object.entries(inputs.tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }

  for (const [tabId, ptyIds] of Object.entries(inputs.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      addBinding(ptyIdToTabId, tabId, ptyId)
    }
  }

  // Why: startup-deferred reattach intentionally leaves inactive tabs out of
  // ptyIdsByTabId, but their daemon sessions are still owned by tab/layout
  // wake hints. Resource Manager should not classify those as orphans.
  for (const tabs of Object.values(inputs.tabsByWorktree)) {
    for (const tab of tabs) {
      addBinding(ptyIdToTabId, tab.id, tab.ptyId)
    }
  }

  for (const [tabId, layout] of Object.entries(inputs.terminalLayoutsByTabId ?? {})) {
    if (!tabIdToWorktreeId.has(tabId)) {
      continue
    }
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      addBinding(ptyIdToTabId, tabId, ptyId)
    }
  }

  return {
    ptyIdToTabId,
    tabIdToWorktreeId,
    boundPtyIds: inputs.workspaceSessionReady ? new Set(ptyIdToTabId.keys()) : new Set()
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
