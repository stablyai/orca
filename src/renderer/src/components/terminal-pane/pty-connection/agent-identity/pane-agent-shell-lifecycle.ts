import { useAppStore } from '@/store/index'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** Shell foreground and agent process lifetime are separate observations. */
export function settlePaneShellForeground(
  session: ConnectPanePtySession,
  reason: 'visible-pty' | 'command-finished' | 'process-exit'
): void {
  // The shell owns input even when a stopped job still exists.
  session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
  const ptyId = session.transport.getPtyId()
  const acceptedStatusSeq = useAppStore
    .getState()
    .agentStatusByPaneKey.get(session.cacheKey)?.acceptedStatusSeq
  // Foreground shell ownership cannot prove that a stopped agent process ended.
  void Promise.resolve(window.api?.agentStatus?.hasVerifiableAgentProcess?.(session.cacheKey))
    .then((verifiable) => {
      if (
        verifiable === true ||
        session.transport.getPtyId() !== ptyId ||
        useAppStore.getState().agentStatusByPaneKey.get(session.cacheKey)?.acceptedStatusSeq !==
          acceptedStatusSeq
      ) {
        return
      }
      // Retire stale agent occupancy when a normal exit returns to the shell.
      const state = useAppStore.getState()
      const sleepingRecord = session.getSleepingRecordForPane(state)
      const wake = session.hibernatedWakeTarget
      // A delayed shell read can settle after exit consumes suppression; preserve only that PTY's exact wake record.
      const isHibernationWakeRecord =
        (ptyId && state.suppressedPtyExitIds[ptyId]) ||
        (wake && wake.record === sleepingRecord?.record && (ptyId === null || wake.ptyId === ptyId))
      session.clearStaleAgentTabTitleOnConfirmedShell()
      // Agents that leave their OSC title (grok, codex) never trip the title exit; Orca's own hibernation stop keeps its chat.
      if (!isHibernationWakeRecord) {
        session.deps.onAgentExitedRef.current(session.pane.leafId)
      }
      // Why: no 133;D backs these proofs, so a deferred command-finished drop keeps its own read.
      if (reason === 'process-exit') {
        // Why: reopen the one-shot visible sample so the next agent typed here is identified.
        session.visibleForegroundSamplePending = false
        session.visibleForegroundSampleSettled = false
      }
      if (reason === 'visible-pty' || reason === 'process-exit') {
        state.clearAgentLaunchConfig(session.cacheKey)
        return
      }
      session.settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
    })
    .catch(console.warn)
}
