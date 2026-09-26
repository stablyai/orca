import { isDormantRecoveryRecord } from '../../../../../shared/agent-session-resume'
import { onDormantRecoveryPaneShellRelease } from '@/lib/dormant-recovery-shell-release'
import { useAppStore } from '@/store'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import { findTerminalTabForPane } from './terminal-tab-id'

const shellReleasedSessions = new WeakSet<ConnectPanePtySession>()

/** Whether the pane holds a dormant recovered session, where any shell would block its Resume. */
export function holdsDormantRecoveryConnect(session: ConnectPanePtySession): boolean {
  if (
    shellReleasedSessions.has(session) ||
    session.paneStartup ||
    session.deps.restoredPtyIdByLeafId?.[session.pane.leafId]
  ) {
    return false
  }
  const record = useAppStore.getState().sleepingAgentSessionsByPaneKey[session.cacheKey]
  return record !== undefined && isDormantRecoveryRecord(record)
}

/** Resumes the connect once Resume binds a PTY to this leaf, or the user starts a shell instead. */
export function waitForDormantRecoveryRelease(
  session: ConnectPanePtySession,
  connect: () => void
): void {
  recordPtyConnectDiagnostic(
    `pane=${session.pane.id} tab=${session.deps.tabId} -> WAIT FOR RECOVERY CHOICE`
  )
  const leafId = session.pane.leafId
  const stop = (): void => {
    unsubscribeRelease()
    unsubscribeStore()
    const index = session.waitTeardowns.indexOf(stop)
    if (index !== -1) {
      session.waitTeardowns.splice(index, 1)
    }
  }
  const unsubscribeRelease = onDormantRecoveryPaneShellRelease(session.cacheKey, () => {
    stop()
    shellReleasedSessions.add(session)
    connect()
  })
  // Why: Resume removes the record only after its launch binds a PTY here, so that PTY ends the
  // wait; a generation bump remounts the pane, which then reattaches on its own.
  const unsubscribeStore = useAppStore.subscribe((state) => {
    const tab = findTerminalTabForPane(state, session.deps.worktreeId, session.deps.tabId)
    const ptyId = tab ? state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId?.[leafId] : undefined
    if (!ptyId || (tab?.generation ?? 0) !== session.tabGeneration) {
      return
    }
    stop()
    session.deps.restoredLeafId = leafId
    session.deps.restoredPtyIdByLeafId = { ...session.deps.restoredPtyIdByLeafId, [leafId]: ptyId }
    connect()
  })
  session.waitTeardowns.push(stop)
}
