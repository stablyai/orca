import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { mayDestroyWithoutOwnerEvidence } from '../../../../shared/pty-listed-session'
import type { DaemonSession } from './resource-usage-merge-types'

export type ResourceSessionBindingInputs = {
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  /**
   * Sessions restore knows exist on an SSH host but has not reattached yet, keyed by tab. Restore
   * skips reattach while the relay is not connected (`terminals.ts` reconnectPersistedTerminals),
   * so these are live remote sessions no other binding source can see. Omitting them is what let
   * Resource Manager classify live agent sessions as orphans and force-kill them (#8459).
   */
  deferredSshSessionIdsByTabId?: Record<string, string>
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

  // Why last: a deferred reattach is the one case where the session is known live but has no
  // live-PTY, tab, or layout binding to find it by.
  for (const [tabId, sessionId] of Object.entries(inputs.deferredSshSessionIdsByTabId ?? {})) {
    if (!tabIdToWorktreeId.has(tabId)) {
      continue
    }
    addBinding(ptyIdToTabId, tabId, sessionId)
  }

  return {
    ptyIdToTabId,
    tabIdToWorktreeId,
    boundPtyIds: inputs.workspaceSessionReady ? new Set(ptyIdToTabId.keys()) : new Set()
  }
}

/**
 * The sessions Resource Manager may offer for bulk destruction: unbound in this renderer *and*
 * unclaimed by any agent. Single source of truth so the advertised count and the set actually
 * killed cannot diverge — that divergence would be live agent sessions (#8459).
 */
export function selectUnboundDaemonSessions(
  sessions: readonly DaemonSession[],
  inputs: ResourceSessionBindingInputs
): DaemonSession[] {
  if (!inputs.workspaceSessionReady) {
    return []
  }
  const { boundPtyIds } = buildResourceSessionBindingIndex(inputs)
  // Why the ownership check: this renderer's binding map is empty during restore, so it cannot
  // decide alone. Only proven absence of an owner qualifies — 'unknown' protects.
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
