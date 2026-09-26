import { useAppStore } from '@/store'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  POST_REPLAY_MODE_RESET
} from '../../../../../shared/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** A proved replacement retires predecessor evidence, without spawning or claiming shell ownership. */
export function retireRemotePtyIncarnation(
  session: ConnectPanePtySession,
  replacedPtyId: string,
  ptyId: string
): void {
  session.authoritativeReattachGeneration += 1
  session.replayPayloadGeneration += 1
  session.pendingReplayData = null
  session.pendingReattachFit?.cancel()
  session.pendingReattachFit = null
  session.clearHiddenOutputRestoreState()
  session.clearRestoredSnapshotBaseline()
  session.deferredReattachLiveData?.discard()
  session.clearPaneMode2031State()
  session.kittyKeyboardModes.reset()
  session.paneForegroundAgentTracker.resetForPtyReplacement()
  session.visibleForegroundSamplePending = false
  session.visibleForegroundSampleSettled = false
  session.deferredCommandFinishedStatusDrop = null
  session.deferredConfirmedShellReconcile = null
  session.clearCommandInferredPaneAgent()
  session.resetPendingShellCommandLine()
  session.rememberReattachPayloadAgentSignal('', { fullScreenReplay: true })
  const state = useAppStore.getState()
  const predecessorHandle = parseRemoteRuntimePtyId(replacedPtyId)?.handle
  const successorHandle = parseRemoteRuntimePtyId(ptyId)?.handle
  // Published rows can already belong to the successor; reused handles carry no incarnation fence.
  if (predecessorHandle && successorHandle && predecessorHandle !== successorHandle) {
    if (state.agentStatusByPaneKey[session.cacheKey]?.terminalHandle === predecessorHandle) {
      state.removeAgentStatus(session.cacheKey)
      session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    }
    if (
      state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.terminalHandle ===
      predecessorHandle
    ) {
      state.clearAgentLaunchConfig(session.cacheKey)
    }
  }
  state.clearPaneForegroundAgent(session.cacheKey)
  session.replacementReplayPending = true
  session.writeReplayData(`${ABORT_TRUNCATED_CONTROL_STRING}${POST_REPLAY_MODE_RESET}`)
}
