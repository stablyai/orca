import type { TerminalNotificationServices } from './terminal-notification-services'
import { useAppStore } from '@/store'
import { hasPendingHookLaneCompletion } from '@/hooks/agent-hook-completion-notifications'
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
  isAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'

export function createTerminalNotificationPolicy(services: TerminalNotificationServices) {
  let agentTaskCompleteNotificationGraceTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteNotificationMaxTimer: ReturnType<typeof setTimeout> | null = null
  let agentTaskCompleteStatusUnsubscribe: (() => void) | null = null
  let agentTaskCompleteNotificationGeneration: number = 0
  let wasAgentTaskCompleteTrackingEnabled: boolean = isAgentTaskCompleteTrackingEnabled()
  let requiresFreshWorkingForAgentTaskCompleteNotification: boolean =
    !wasAgentTaskCompleteTrackingEnabled
  let wasAgentTaskCompleteOsNotificationEnabled: boolean = isAgentTaskCompleteNotificationEnabled()
  let hookOwnedIdleAbsorbsBell = false
  let pendingTerminalBellNotification: boolean = false
  let terminalBellNotificationTimer: ReturnType<typeof setTimeout> | null = null
  // ─── Attention signal: BEL ────────────────────────────────────────────
  //
  // BEL (0x07) is the attention signal. A BEL raises tab- and worktree-level
  // indicators, and fires an OS notification. The experimental pane marker
  // clears when the user interacts with the exact pane.
  //
  // The one case where BEL falsely fires is when a crashed TUI left DEC
  // private mode 1004 (focus event reporting) enabled — pane clicks then
  // emit `\e[I`/`\e[O` into the shell, zsh treats them as unbound keys and
  // rings the bell. This is specific to terminals with cross-restart
  // persistence (as we have); our fix is to reset 1004 and friends after
  // scrollback replay so the mode state matches the fresh shell
  // underneath. See POST_REPLAY_MODE_RESET in shared/terminal-mode-reset-profiles.ts.
  const onBell = (): void => {
    // Why: restored Claude Code sessions have been observed to emit a real
    // standalone BEL some time after daemon snapshot reattach, even when Orca
    // did not just forward focus/control input. Treat the BEL as authoritative
    // PTY output here; any product-side suppression should be an explicit UX
    // decision higher up, not a transport-layer guess.
    services.markTerminalBell({
      worktreeId: services.worktreeId,
      tabId: services.tabId,
      paneKey: services.paneKey
    })
    // Why: agent CLIs often emit BEL in the same completion burst as their
    // working->idle title change. Delay only the OS notification so the richer
    // agent-complete notification can win the main-process worktree cooldown.
    if (hookOwnedIdleAbsorbsBell === true) {
      return
    }
    pendingTerminalBellNotification = true
    if (!hasPendingAgentTaskCompleteNotification()) {
      scheduleTerminalBellNotification()
    }
  }

  const clearTerminalBellNotificationTimer = (): void => {
    if (terminalBellNotificationTimer !== null) {
      clearTimeout(terminalBellNotificationTimer)
      terminalBellNotificationTimer = null
    }
  }

  const scheduleTerminalBellNotification = (): void => {
    if (terminalBellNotificationTimer !== null) {
      return
    }
    terminalBellNotificationTimer = setTimeout(() => {
      terminalBellNotificationTimer = null
      if (!services.isLive()) {
        pendingTerminalBellNotification = false
        return
      }
      if (hasPendingAgentTaskCompleteNotification()) {
        return
      }
      pendingTerminalBellNotification = false
      if (
        isAgentTaskCompleteNotificationEnabled() &&
        hasPendingHookLaneCompletion(services.paneKey, services.getPtyId())
      ) {
        return
      }
      services.dispatchNotification({
        source: 'terminal-bell',
        paneKey: services.paneKey,
        ptyId: services.getPtyId(),
        workspaceOwner: services.getWorkspaceOwner()
      })
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
  }

  const hasPendingAgentTaskCompleteNotification = (): boolean =>
    isAgentTaskCompleteNotificationEnabled() &&
    (services.hasPendingHookDoneCompletion() ||
      agentTaskCompleteNotificationGraceTimer !== null ||
      agentTaskCompleteNotificationMaxTimer !== null ||
      agentTaskCompleteStatusUnsubscribe !== null)

  const clearPendingAgentTaskCompleteNotification = (): void => {
    if (agentTaskCompleteNotificationGraceTimer !== null) {
      clearTimeout(agentTaskCompleteNotificationGraceTimer)
      agentTaskCompleteNotificationGraceTimer = null
    }
    if (agentTaskCompleteNotificationMaxTimer !== null) {
      clearTimeout(agentTaskCompleteNotificationMaxTimer)
      agentTaskCompleteNotificationMaxTimer = null
    }
    hookOwnedIdleAbsorbsBell = false
    if (agentTaskCompleteStatusUnsubscribe !== null) {
      agentTaskCompleteStatusUnsubscribe()
      agentTaskCompleteStatusUnsubscribe = null
    }
  }

  const absorbBurstBellForHookOwnedIdle = (): void => {
    if (hasPendingAgentTaskCompleteNotification()) {
      return
    }
    pendingTerminalBellNotification = false
    clearTerminalBellNotificationTimer()
    hookOwnedIdleAbsorbsBell = true
    agentTaskCompleteNotificationMaxTimer = setTimeout(() => {
      agentTaskCompleteNotificationMaxTimer = null
      hookOwnedIdleAbsorbsBell = false
    }, AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
  }

  const syncAgentTaskCompleteTrackingEnabled = (): boolean => {
    const enabled = isAgentTaskCompleteTrackingEnabled()
    const osNotificationsEnabled = isAgentTaskCompleteNotificationEnabled()
    if (
      !osNotificationsEnabled &&
      wasAgentTaskCompleteOsNotificationEnabled &&
      pendingTerminalBellNotification
    ) {
      scheduleTerminalBellNotification()
    }
    if (!enabled && wasAgentTaskCompleteTrackingEnabled) {
      // Why: disabling every completion consumer is an event-time boundary.
      // Drop pending alerts while preserving accepted-hook lifecycle state.
      agentTaskCompleteNotificationGeneration += 1
      requiresFreshWorkingForAgentTaskCompleteNotification = true
      clearPendingAgentTaskCompleteNotification()
      if (pendingTerminalBellNotification) {
        scheduleTerminalBellNotification()
      }
    } else if (enabled && !wasAgentTaskCompleteTrackingEnabled) {
      // Why: a pane may have observed work while all completion consumers were
      // disabled. Re-enabling should not let the next idle event report old work.
      requiresFreshWorkingForAgentTaskCompleteNotification = true
    }
    wasAgentTaskCompleteTrackingEnabled = enabled
    wasAgentTaskCompleteOsNotificationEnabled = osNotificationsEnabled
    return enabled
  }
  const scheduleAgentTaskCompleteNotification = (
    title: string,
    options: {
      allowDoneDetailAfterGrace?: boolean
      agentStatusSnapshot?: AgentCompletionStatusSnapshot
      agentCompletionSource?: AgentCompletionDispatchMeta['source']
    } = {}
  ): void => {
    if (
      !syncAgentTaskCompleteTrackingEnabled() ||
      requiresFreshWorkingForAgentTaskCompleteNotification
    ) {
      return
    }
    clearPendingAgentTaskCompleteNotification()
    let graceElapsed = false
    const generationAtSchedule = agentTaskCompleteNotificationGeneration
    const agentStatusAtSchedule = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
    const hasNewerActiveHookStatus = (): boolean => {
      const currentStatus = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
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
      clearPendingAgentTaskCompleteNotification()
      if (
        generationAtSchedule !== agentTaskCompleteNotificationGeneration ||
        !syncAgentTaskCompleteTrackingEnabled() ||
        hasNewerActiveHookStatus()
      ) {
        return
      }
      if (!services.isLive()) {
        return
      }
      // Why: terminal attention is a visual pane affordance, not an OS
      // notification. Route through dispatch so stale pane completions are
      // rejected before unread attention is marked.
      pendingTerminalBellNotification = false
      clearTerminalBellNotificationTimer()
      services.dispatchNotification({
        source: 'agent-task-complete',
        terminalTitle: title,
        paneKey: services.paneKey,
        ptyId: services.getPtyId(),
        workspaceOwner: services.getWorkspaceOwner(),
        ...(options.agentCompletionSource
          ? { agentCompletionSource: options.agentCompletionSource }
          : {}),
        ...(options.agentStatusSnapshot ? { agentStatusSnapshot: options.agentStatusSnapshot } : {})
      })
    }

    const dispatchIfDetailed = (): void => {
      if (hasNewerActiveHookStatus()) {
        // Why: the confirmed exit belongs to the row captured above; a replaced
        // active row means a newer turn started during the notification delay.
        clearPendingAgentTaskCompleteNotification()
        return
      }
      if (!graceElapsed) {
        return
      }
      const entry = useAppStore.getState().agentStatusByPaneKey[services.paneKey]
      if (canDispatchAgentNotificationAfterGrace(entry, options)) {
        dispatch()
      }
    }

    agentTaskCompleteStatusUnsubscribe = useAppStore.subscribe(dispatchIfDetailed)
    agentTaskCompleteNotificationGraceTimer = setTimeout(() => {
      agentTaskCompleteNotificationGraceTimer = null
      graceElapsed = true
      dispatchIfDetailed()
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    // Why: some agents never surface assistant text through hooks. Keep a hard
    // cap so task-complete notifications still fire instead of waiting forever.
    agentTaskCompleteNotificationMaxTimer = setTimeout(
      dispatch,
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
    )
  }
  return {
    absorbBurstBellForHookOwnedIdle,
    onBell,
    clearTerminalBellNotificationTimer,
    scheduleTerminalBellNotification,
    hasPendingAgentTaskCompleteNotification,
    clearPendingAgentTaskCompleteNotification,
    syncAgentTaskCompleteTrackingEnabled,
    scheduleAgentTaskCompleteNotification,
    get agentTaskCompleteNotificationGraceTimer() {
      return agentTaskCompleteNotificationGraceTimer
    },
    set agentTaskCompleteNotificationGraceTimer(value: ReturnType<typeof setTimeout> | null) {
      agentTaskCompleteNotificationGraceTimer = value
    },
    get agentTaskCompleteNotificationMaxTimer() {
      return agentTaskCompleteNotificationMaxTimer
    },
    set agentTaskCompleteNotificationMaxTimer(value: ReturnType<typeof setTimeout> | null) {
      agentTaskCompleteNotificationMaxTimer = value
    },
    get agentTaskCompleteStatusUnsubscribe() {
      return agentTaskCompleteStatusUnsubscribe
    },
    set agentTaskCompleteStatusUnsubscribe(value: (() => void) | null) {
      agentTaskCompleteStatusUnsubscribe = value
    },
    get agentTaskCompleteNotificationGeneration() {
      return agentTaskCompleteNotificationGeneration
    },
    set agentTaskCompleteNotificationGeneration(value: number) {
      agentTaskCompleteNotificationGeneration = value
    },
    get wasAgentTaskCompleteTrackingEnabled() {
      return wasAgentTaskCompleteTrackingEnabled
    },
    set wasAgentTaskCompleteTrackingEnabled(value: boolean) {
      wasAgentTaskCompleteTrackingEnabled = value
    },
    get requiresFreshWorkingForAgentTaskCompleteNotification() {
      return requiresFreshWorkingForAgentTaskCompleteNotification
    },
    set requiresFreshWorkingForAgentTaskCompleteNotification(value: boolean) {
      requiresFreshWorkingForAgentTaskCompleteNotification = value
    },
    get wasAgentTaskCompleteOsNotificationEnabled() {
      return wasAgentTaskCompleteOsNotificationEnabled
    },
    set wasAgentTaskCompleteOsNotificationEnabled(value: boolean) {
      wasAgentTaskCompleteOsNotificationEnabled = value
    },
    get pendingTerminalBellNotification() {
      return pendingTerminalBellNotification
    },
    set pendingTerminalBellNotification(value: boolean) {
      pendingTerminalBellNotification = value
    },
    get terminalBellNotificationTimer() {
      return terminalBellNotificationTimer
    },
    set terminalBellNotificationTimer(value: ReturnType<typeof setTimeout> | null) {
      terminalBellNotificationTimer = value
    }
  }
}
