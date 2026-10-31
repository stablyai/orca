/** Keep live, parked-watcher and side-effect completion policy aligned without importing pane/xterm dependencies. */
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

/** Delay BEL/completion banners so richer same-burst agent detail can win. */
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

/** Track completions once settings hydrate; each delivery surface applies its own filter. */
export function isAgentTaskCompleteTrackingEnabledFromState(state: {
  settings: object | null
}): boolean {
  // Mobile delivery can remain enabled when desktop banners and attention are off.
  return state.settings !== null
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
  // Milestone done may resume; wait for max quiet while input-needed states can notify when detail arrives.
  return (
    hasAgentNotificationDetail(entry) &&
    (entry?.state !== 'done' || options.allowDoneDetailAfterGrace === true)
  )
}
