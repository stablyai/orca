import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { mayDestroyWithoutOwnerEvidence } from '../../../../shared/pty-listed-session'
import type { DaemonSession } from './resource-usage-merge-types'

export type ResourceSessionBindingInputs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  /** Live SSH sessions awaiting relay reattachment have no other binding; retain them so agent sessions cannot become killable orphans. */
  deferredSshSessionIdsByTabId?: Record<string, string>
  workspaceSessionReady: boolean
}

export type ResourceSessionBindingIndex = {
  ptyIdToTabId: Map<string, string>
  tabIdToWorktreeId: Map<string, string>
  boundPtyIds: Set<string>
  tabsByIdByWorktree: Map<string, Map<string, { tab: TerminalTab; index: number }>>
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
  const tabsByIdByWorktree: ResourceSessionBindingIndex['tabsByIdByWorktree'] = new Map()

  for (const [worktreeId, tabs] of Object.entries(inputs.tabsByWorktree)) {
    const byId = new Map<string, { tab: TerminalTab; index: number }>()
    tabs.forEach((tab, index) => {
      const id = tab.id
      tabIdToWorktreeId.set(id, worktreeId)
      // First tab wins, matching the findIndex scan this index replaces.
      if (!byId.has(id)) {
        byId.set(id, { tab, index })
      }
    })
    tabsByIdByWorktree.set(worktreeId, byId)
  }

  for (const [tabId, ptyIds] of Object.entries(inputs.ptyIdsByTabId)) {
    for (const ptyId of ptyIds) {
      addBinding(ptyIdToTabId, tabId, ptyId)
    }
  }

  // Deferred inactive tabs retain ownership through tab/layout wake hints even without live-PTY bindings.
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

  // Add deferred SSH sessions last because earlier binding sources cannot see their live sessions.
  for (const [tabId, sessionId] of Object.entries(inputs.deferredSshSessionIdsByTabId ?? {})) {
    if (!tabIdToWorktreeId.has(tabId)) {
      continue
    }
    addBinding(ptyIdToTabId, tabId, sessionId)
  }

  return {
    ptyIdToTabId,
    tabIdToWorktreeId,
    tabsByIdByWorktree,
    boundPtyIds: inputs.workspaceSessionReady ? new Set(ptyIdToTabId.keys()) : new Set()
  }
}

/** Share bulk-kill eligibility between the count and action: sessions must be unbound with proven owner absence. */
export function selectUnboundDaemonSessions(
  sessions: readonly DaemonSession[],
  inputs: ResourceSessionBindingInputs
): DaemonSession[] {
  if (!inputs.workspaceSessionReady) {
    return []
  }
  const { boundPtyIds } = buildResourceSessionBindingIndex(inputs)
  // An empty restore-time binding map cannot prove idleness; unknown ownership protects the session.
  return sessions.filter(
    (session) => !boundPtyIds.has(session.id) && mayDestroyWithoutOwnerEvidence(session)
  )
}

export function countUnboundDaemonSessions(
  sessions: readonly DaemonSession[],
  inputs: ResourceSessionBindingInputs
): number {
  return selectUnboundDaemonSessions(sessions, inputs).length
}
