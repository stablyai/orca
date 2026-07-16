/**
 * Agent-task-complete notification policy predicates and timing constants.
 *
 * Why extracted from pty-connection.ts: the parked byte watcher and the
 * pty:sideEffect facts handler apply the exact live-path semantics without a
 * pane, and policy must not drift between the three consumers
 * (docs/reference/terminal-side-effect-authority.md). This module is
 * deliberately dependency-light — no pane/xterm imports — so pane-less
 * consumers can use it.
 */
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'

/** Delay before BEL/completion OS notifications so the richer
 *  agent-task-complete notification can win a same-burst BEL race. */
export const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
/** Hard cap on waiting for hook detail before dispatching a completion. */
export const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1500
export const AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS = 10_000

type NotificationSettingsState = {
  settings: Pick<GlobalSettings, 'notifications' | 'experimentalTerminalAttention'> | null
}

export function isAgentTaskCompleteOsNotificationEnabledFromState(
  state: NotificationSettingsState
): boolean {
  const notifications = state.settings?.notifications
  return notifications?.enabled !== false && notifications?.agentTaskComplete !== false
}

export function isTerminalAttentionEnabledFromState(state: NotificationSettingsState): boolean {
  return state.settings?.experimentalTerminalAttention === true
}

/** Completion tracking runs when either consumer (OS notification or the
 *  experimental terminal-attention marker) is enabled. */
export function isAgentTaskCompleteTrackingEnabledFromState(
  state: NotificationSettingsState
): boolean {
  return (
    isAgentTaskCompleteOsNotificationEnabledFromState(state) ||
    isTerminalAttentionEnabledFromState(state)
  )
}

export function hasAgentNotificationDetail(entry: AgentStatusEntry | undefined): boolean {
  return Boolean(
    entry &&
    Date.now() - entry.updatedAt <= AGENT_TASK_COMPLETE_NOTIFICATION_DETAIL_MAX_AGE_MS &&
    (entry.lastAssistantMessage || entry.toolName || entry.toolInput)
  )
}

export function canDispatchAgentNotificationAfterGrace(
  entry: AgentStatusEntry | undefined,
  options: { allowDoneDetailAfterGrace?: boolean } = {}
): boolean {
  // Why: hook-backed goal/mission loops can report `done` between milestones.
  // User-input states may notify as soon as detail arrives, but `done` waits
  // for the max quiet window so resumed work can cancel the pending banner.
  return (
    hasAgentNotificationDetail(entry) &&
    (entry?.state !== 'done' || options.allowDoneDetailAfterGrace === true)
  )
}
