import { agentTypeToIconAgent } from '@/lib/agent-status'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { readTerminalInterface } from '../../native-chat/terminal-interface-presentation'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { useAppStore } from '@/store'
import { retireLiveAgentRowOnConfirmedProcessExit } from './confirmed-process-exit-row-retire'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The known agent that owns this pane now; async reads are stale only once another one does. */
export function readPaneObservationOwner(session: ConnectPanePtySession): string | null {
  const agentType = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.agentType
  return agentType && agentType !== 'unknown' ? agentType : null
}

/** The same current-pane and recovery fence applies before and after asynchronous cleanup. */
export function readPaneDepartureState(
  session: ConnectPanePtySession,
  process?: RecognizedAgentProcess
): ReturnType<typeof useAppStore.getState> | null {
  const state = useAppStore.getState()
  const ptyId = session.transport.getPtyId()
  const sleeping = session.getSleepingRecordForPane(state)
  const wake = session.hibernatedWakeTarget
  const current = state.agentStatusByPaneKey[session.cacheKey]
  if (
    session.disposed ||
    !ptyId ||
    state.suppressedPtyExitIds[ptyId] ||
    session.deps.isPtyShutdownPending(ptyId) ||
    session.restartReplacementPtyId === ptyId ||
    (wake && wake.record === sleeping?.record && wake.ptyId === ptyId) ||
    (process &&
      current?.agentType &&
      current.agentType !== 'unknown' &&
      resolveCompatibleAgentTypeForOwner(current.agentType, process.agent) !== process.agent)
  ) {
    return null
  }
  return state
}

/** D settles turn rows; shell ownership releases presentation, and confirmed death retires lifetime. */
export function installAgentDeparture(session: ConnectPanePtySession): void {
  session.paneHasLiveHookAgentIcon = (state: ReturnType<typeof useAppStore.getState>): boolean => {
    const entry = state.agentStatusByPaneKey[session.cacheKey]
    return entry?.state !== 'done' && Boolean(agentTypeToIconAgent(entry?.agentType))
  }
  session.paneHasKnownAgentIdentity = (): boolean => {
    const state = useAppStore.getState()
    const registeredLaunchAgent =
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity?.agentType
    return (
      Boolean(state.paneForegroundAgentByPaneKey[session.cacheKey]?.agent) ||
      session.paneHasLiveHookAgentIcon(state) ||
      isTuiAgent(registeredLaunchAgent)
    )
  }
  session.acceptAgentDeparture = (
    kind: 'foreground-release' | 'command-finished' | 'process-exit' | 'title',
    process?: RecognizedAgentProcess
  ): boolean => {
    const state = readPaneDepartureState(session, process)
    if (!state) {
      return false
    }
    const hostPresentation = Boolean(readTerminalInterface(state, session.cacheKey))
    const sleeping = session.getSleepingRecordForPane(state)
    if (kind === 'command-finished') {
      if (!session.deferredCommandFinishedStatusDrop) {
        return false
      }
      session.settleDeferredCommandFinishedStatusDrop({ confirmedShell: true })
      return true
    }
    if (
      kind === 'foreground-release' &&
      state.paneForegroundAgentByPaneKey[session.cacheKey]?.shellForeground
    ) {
      return true
    }
    // Shell ownership releases input; only a separately confirmed death retires lifetime state.
    if (kind === 'foreground-release') {
      session.paneForegroundAgentTracker.onShellForegroundObserved()
    } else if (kind === 'process-exit' && process) {
      session.deferredCommandFinishedStatusDrop = null
      session.deferredConfirmedShellReconcile = null
      session.paneForegroundAgentTracker.onProcessExitConfirmed(process)
      if (sleeping) {
        session.clearSleepingRecordProviderDuplicates(state, sleeping)
      }
      state.clearAgentLaunchConfig(session.cacheKey)
      retireLiveAgentRowOnConfirmedProcessExit(session, process)
    }
    // Ordinary recognized-process cleanup still runs for capable hosts and old readers.
    if (hostPresentation) {
      return true
    }
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    if (kind !== 'title') {
      session.clearStaleAgentTabTitleOnConfirmedShell()
      session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
      session.visibleForegroundSamplePending = false
      session.visibleForegroundSampleSettled = false
    }
    return true
  }
}
