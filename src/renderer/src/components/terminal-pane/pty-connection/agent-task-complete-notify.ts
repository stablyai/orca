import type { AgentIdleEdgeMeta } from '../../../../../shared/terminal-output-side-effects'
import { idleEdgeSettledAtRest, isClaudeIdleEdge } from '@/lib/agent-idle-edge'
import { captureNotificationTransportOwner } from '@/attention/notification-subject-owner'
import { useAppStore } from '@/store'
import { isFreshNonDoneAgentStatus } from '../../../../../shared/agent-status-types'
import type {
  AgentCompletionDispatchMeta,
  AgentCompletionStatusSnapshot
} from '../agent-completion-coordinator-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../shared/agent-title-owner'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS,
  canDispatchAgentNotificationAfterGrace
} from '../agent-task-complete-policy'

import { subscribeAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installAgentIdleWorkingHandlers } from './agent-idle-working-handlers'

/** Hook-owned idle absorbs the burst’s current or late BEL through the completion max wait, like claimed title completion. */
export function absorbBurstBellForHookOwnedIdle(session: ConnectPanePtySession): void {
  if (session.hasPendingAgentTaskCompleteNotification()) {
    return
  }
  session.pendingTerminalBellNotification = false
  session.clearTerminalBellNotificationTimer()
  session.hookOwnedIdleAbsorbsBell = true
  // Why: main's claimed completion stayed pending on a `done` row for its whole max wait.
  session.agentTaskCompleteNotificationMaxTimer = setTimeout(() => {
    session.agentTaskCompleteNotificationMaxTimer = null
    session.hookOwnedIdleAbsorbsBell = false
  }, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
}

export function installAgentTaskCompleteNotify(session: ConnectPanePtySession): void {
  session.scheduleAgentTaskCompleteNotification = (
    title: string,
    options: {
      allowDoneDetailAfterGrace?: boolean
      agentStatusSnapshot?: AgentCompletionStatusSnapshot
      agentCompletionSource?: AgentCompletionDispatchMeta['source']
    } = {}
  ): void => {
    if (
      !session.syncAgentTaskCompleteTrackingEnabled() ||
      session.requiresFreshWorkingForAgentTaskCompleteNotification
    ) {
      return
    }
    session.clearPendingAgentTaskCompleteNotification()
    let graceElapsed = false
    const generationAtSchedule = session.agentTaskCompleteNotificationGeneration
    const agentStatusAtSchedule = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    const hasNewerActiveHookStatus = (): boolean => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      const scheduledAgentType = agentStatusAtSchedule?.agentType
      const currentAgentForScheduledTurn = resolveCompatibleAgentTypeForOwner(
        currentStatus?.agentType,
        scheduledAgentType
      )
      const hasDifferentKnownAgent = Boolean(
        currentStatus?.agentType &&
        scheduledAgentType &&
        currentStatus.agentType !== 'unknown' &&
        scheduledAgentType !== 'unknown' &&
        currentAgentForScheduledTurn !== scheduledAgentType
      )
      return (
        options.agentCompletionSource === 'process-exit' &&
        isFreshNonDoneAgentStatus(currentStatus) &&
        (!agentStatusAtSchedule ||
          currentStatus.state !== agentStatusAtSchedule.state ||
          currentStatus.stateStartedAt !== agentStatusAtSchedule.stateStartedAt ||
          hasDifferentKnownAgent)
      )
    }

    const dispatch = (): void => {
      session.clearPendingAgentTaskCompleteNotification()
      if (
        generationAtSchedule !== session.agentTaskCompleteNotificationGeneration ||
        !session.syncAgentTaskCompleteTrackingEnabled() ||
        hasNewerActiveHookStatus()
      ) {
        return
      }
      if (session.disposed) {
        return
      }
      // Use shared dispatch so stale completions are rejected before marking pane attention.
      session.pendingTerminalBellNotification = false
      session.clearTerminalBellNotificationTimer()
      session.deps.dispatchNotification({
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: session.cacheKey,
        ptyId: session.transport.getPtyId(),
        workspaceOwner: captureNotificationTransportOwner(session.transport),
        ...(options.agentCompletionSource
          ? { agentCompletionSource: options.agentCompletionSource }
          : {}),
        ...(options.agentStatusSnapshot ? { agentStatusSnapshot: options.agentStatusSnapshot } : {})
      })
    }

    const dispatchIfDetailed = (): void => {
      if (hasNewerActiveHookStatus()) {
        // A replaced active row belongs to a newer turn than the confirmed exit captured before the delay.
        session.clearPendingAgentTaskCompleteNotification()
        return
      }
      if (!graceElapsed) {
        return
      }
      const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
      if (canDispatchAgentNotificationAfterGrace(entry, options)) {
        dispatch()
      }
    }

    session.agentTaskCompleteStatusUnsubscribe = useAppStore.subscribe(dispatchIfDetailed)
    session.agentTaskCompleteNotificationGraceTimer = setTimeout(() => {
      session.agentTaskCompleteNotificationGraceTimer = null
      graceElapsed = true
      dispatchIfDetailed()
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    // Bound notification wait because some agents never publish assistant text through hooks.
    session.agentTaskCompleteNotificationMaxTimer = setTimeout(
      dispatch,
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
    )
  }
  session.agentTaskCompleteSettingsUnsubscribe = subscribeAgentTaskCompleteTrackingEnabled(() => {
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.agentCompletionCoordinator.startProcessTracking()
    }
  })

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
  installAgentIdleWorkingHandlers(session)
}
