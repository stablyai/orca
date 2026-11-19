import { useAppStore } from '@/store/index'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { isRemoteExecutionHostPtyId } from '../../../../../../shared/execution-host/remote-execution-host-pty-id'

/** Shell foreground and agent process lifetime are separate observations. */
export function settlePaneShellForeground(
  session: ConnectPanePtySession,
  reason: 'visible-pty' | 'command-finished' | 'process-exit'
): void {
  const state = useAppStore.getState()
  const ptyId = session.transport.getPtyId()
  const sleepingRecord = session.getSleepingRecordForPane(state)
  const wake = session.hibernatedWakeTarget
  const isHibernationWakeRecord =
    (ptyId && state.suppressedPtyExitIds[ptyId]) ||
    (wake && wake.record === sleepingRecord?.record && (ptyId === null || wake.ptyId === ptyId))
  // Main proves a local agent's exit (shell alone, no stopped job) before retiring its record; a
  // remote host has no such proof yet, so its returning shell retires the record as before.
  if (sleepingRecord && !isHibernationWakeRecord && ptyId && isRemoteExecutionHostPtyId(ptyId)) {
    session.clearSleepingRecordProviderDuplicates(state, sleepingRecord)
  }
  session.clearStaleAgentTabTitleOnConfirmedShell()
  session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
  if (!isHibernationWakeRecord) {
    session.deps.onAgentExitedRef.current(session.pane.leafId)
  }
  if (reason === 'process-exit') {
    session.visibleForegroundSamplePending = false
    session.visibleForegroundSampleSettled = false
  }
  if (reason === 'visible-pty' || reason === 'process-exit') {
    state.clearAgentLaunchConfig(session.cacheKey)
    if (ptyId && !isRemoteExecutionHostPtyId(ptyId) && !isHibernationWakeRecord) {
      // Quiet wake launches can exit without ever posting a hook row or command mark.
      session.reconcileEndedProcessIfPaneQuiet(
        state.agentStatusByPaneKey.get(session.cacheKey)?.acceptedStatusSeq
      )
    }
  } else {
    session.settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
  }
}
