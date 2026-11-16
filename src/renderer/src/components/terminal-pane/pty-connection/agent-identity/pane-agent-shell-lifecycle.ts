import { useAppStore } from '@/store/index'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

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
  } else {
    session.settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
  }
  // Only the monitor's settled no-agent/no-children proof can retire recovery without command marks.
  if (reason !== 'process-exit' || !sleepingRecord || isHibernationWakeRecord) {
    return
  }
  const acceptedStatusSeq = useAppStore
    .getState()
    .agentStatusByPaneKey.get(session.cacheKey)?.acceptedStatusSeq
  void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(session.cacheKey))
    .then((verifiable) => {
      const current = useAppStore.getState()
      if (
        verifiable === true ||
        session.transport.getPtyId() !== ptyId ||
        current.agentStatusByPaneKey.get(session.cacheKey)?.acceptedStatusSeq !==
          acceptedStatusSeq ||
        session.getSleepingRecordForPane(current)?.record !== sleepingRecord.record ||
        (ptyId && current.suppressedPtyExitIds[ptyId])
      ) {
        return
      }
      session.clearSleepingRecordProviderDuplicates(current, sleepingRecord)
    })
    .catch(console.warn)
}
