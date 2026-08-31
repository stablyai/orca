import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
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

import {
  isAgentTaskCompleteNotificationEnabled,
  subscribeAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installAgentIdleWorkingHandlers } from './agent-idle-working-handlers'

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
      // Why: terminal attention is a visual pane affordance, not an OS
      // notification. Route through dispatch so stale pane completions are
      // rejected before unread attention is marked.
      const shouldDispatchOsNotification = isAgentTaskCompleteNotificationEnabled()
      session.pendingTerminalBellNotification = false
      session.clearTerminalBellNotificationTimer()
      session.deps.dispatchNotification({
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: session.cacheKey,
        ...(options.agentCompletionSource
          ? { agentCompletionSource: options.agentCompletionSource }
          : {}),
        ...(shouldDispatchOsNotification ? {} : { suppressOsNotification: true }),
        ...(options.agentStatusSnapshot ? { agentStatusSnapshot: options.agentStatusSnapshot } : {})
      })
    }

    const dispatchIfDetailed = (): void => {
      if (hasNewerActiveHookStatus()) {
        // Why: the confirmed exit belongs to the row captured above; a replaced
        // active row means a newer turn started during the notification delay.
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
    // Why: some agents never surface assistant text through hooks. Keep a hard
    // cap so task-complete notifications still fire instead of waiting forever.
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

  // ─── Agent task-complete: notification-backed attention ───────────────
  //
  // The working→idle title transition drives two independent concerns:
  //   1. The Claude prompt-cache countdown in the sidebar.
  //   2. The "Agent Task Complete" OS notification users toggle in Settings.
  //
  // This path raises the same terminal attention marker as BEL through the
  // shared notification dispatcher. Not every agent CLI reliably emits BEL on
  // completion (Gemini, some Codex flows), and the highlight needs to remain
  // findable after the OS banner is gone. Double-firing with a concurrent BEL
  // is handled by delaying the BEL OS notification below; main still keeps a
  // 5 s per-worktree dedupe as the final guard.
  session.onAgentBecameIdle = (
    title: string,
    meta?: { staleWorkingTitleClear?: boolean }
  ): void => {
    // Why: a stale-derived idle comes from main's UNTHROTTLED 3s timer, not
    // observed bytes — a merely-paused agent (>3s silent mid-task, window
    // minimized) would otherwise mint a false task-complete OS notification
    // that renderer timer throttling previously damped. Clear session-tied
    // state only; never schedule completion attention from it.
    if (meta?.staleWorkingTitleClear) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, null)
      return
    }
    const currentState = useAppStore.getState()
    const activeHookStatus = currentState.agentStatusByPaneKey[session.cacheKey]
    if (session.shouldSuppressTitleCompletionForFreshHook(title, activeHookStatus)) {
      // Why: agent CLIs can briefly publish an idle title while hook status
      // still says the same agent turn is active (e.g. during tool output).
      if (activeHookStatus) {
        session.preserveSuppressedTitleSideEffects(title, activeHookStatus)
      }
      return
    }
    // Why: only start the prompt-cache countdown for Claude agents — other
    // agents have different (or no) prompt-caching semantics and showing a
    // timer for them would be misleading.
    //
    // Why we check `settings !== null` separately: during startup, settings
    // hydrate asynchronously after terminals reconnect. If we treat null
    // as disabled, the first working→idle transition on a restored Claude
    // tab silently drops the timer. Writing a timestamp is cheap and the
    // CacheTimer component gates rendering on the enabled flag, so a
    // spurious write when the feature turns out to be disabled is harmless.
    const settings = currentState.settings
    if (isClaudeAgent(title) && (settings === null || settings.promptCacheTimerEnabled)) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, Date.now())
    }
    if (detectAgentStatusFromTitle(title) === 'idle') {
      session.setFocusReportSuppressionForAgentCompletion(title, activeHookStatus?.agentType)
    }
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Why: some agent TUIs leave xterm renderer modes active after a turn.
    // Reset cursor everywhere, and Kitty keyboard state on native Windows.
    session.queueAgentIdleTerminalModeReset()
  }
  installAgentIdleWorkingHandlers(session)
}
