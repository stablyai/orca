import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { AgentIdleEdgeMeta } from '../../../../../../shared/terminal/output/terminal-output-side-effects'
import {
  idleEdgeSettledAtRest,
  isClaudeIdleEdge
} from '@/components/terminal-pane/agent-status/agent-idle-edge'
import { useAppStore } from '@/store/index'

export function installPaneAgentTitleLifecycle(session: ConnectPanePtySession): void {
  // Completion must mark durable pane attention even without BEL; delayed BEL dispatch and main dedup prevent duplicate OS notices.
  session.onAgentBecameIdle = (title: string, meta?: AgentIdleEdgeMeta): void => {
    // Stale-title expiry is not observed completion; clear session state without announcing a merely paused agent.
    if (meta?.staleWorkingTitleClear) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, null)
      return
    }
    const currentState = useAppStore.getState()
    const activeHookStatus = currentState.agentStatusByPaneKey[session.cacheKey]
    if (session.shouldSuppressTitleCompletionForFreshHook(title, activeHookStatus)) {
      // Idle titles can appear mid-tool while hooks still own an active turn.
      if (activeHookStatus) {
        session.preserveSuppressedTitleSideEffects(title, activeHookStatus)
      }
      return
    }
    // Only Claude uses this cache timer; allow pre-hydration timestamps so restored idle transitions are not lost before settings arrive.
    const settings = currentState.settings
    if (
      isClaudeIdleEdge(title, activeHookStatus) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, Date.now())
    }
    if (idleEdgeSettledAtRest(title, meta)) {
      session.setFocusReportSuppressionForAgentCompletion(title, activeHookStatus?.agentType)
    }
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Reset cursor style after idle; negotiated keyboard modes remain owned by the live application.
    session.queueAgentIdleTerminalModeReset()
  }
  session.onAgentBecameWorking = (): void => {
    session.suppressNativeWindowsIdleCodexFocusReports = false
    session.clearSuppressedTitleSideEffects()
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.requiresFreshWorkingForAgentTaskCompleteNotification = false
      session.agentCompletionCoordinator.observeTitleWorking()
    }
    // New API calls refresh cache TTL; restart the countdown only at the next idle transition.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearPendingAgentTaskCompleteNotification()
    if (session.pendingTerminalBellNotification) {
      session.scheduleTerminalBellNotification()
    }
  }
  session.onAgentExited = (): void => {
    // Transient reconnect ineligibility cannot prevent authoritative shell-title exit from native chat.
    session.deps.onAgentExitedRef.current(session.pane.leafId)
    session.clearSuppressedTitleSideEffects()
    session.clearCommandInferredPaneAgent()
    session.requestKnownWindowsShiftEnterReconfirmation()
    // Clear cache countdown when title returns to shell; process/PTY lifecycle owns actual agent-row removal.
    session.deps.setCacheTimerStartedAt(session.cacheKey, null)
    session.clearTitleOnlyInterruptTimer()
    // Why: title reversion alone is not process death. The process/PTY tracker
    // owns removing agent rows when the TUI actually exits.
  }
}
