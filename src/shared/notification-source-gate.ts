import { isAgentNeedsInputAlert } from './mobile-push-alert'
import type { NotificationSettings } from './notification-settings-types'

type SourceGateSettings = Pick<
  NotificationSettings,
  'enabled' | 'agentTaskComplete' | 'agentNeedsInput' | 'terminalBell'
>

/** The desktop's per-source preferences; paired phones receive an alert only when this allows it. */
export function isNotificationSourceEnabled(
  settings: SourceGateSettings,
  source: string,
  agentState: string | undefined
): boolean {
  if (!settings.enabled) {
    return false
  }
  if (source === 'terminal-bell') {
    return settings.terminalBell
  }
  if (source !== 'agent-task-complete') {
    return true
  }
  return isAgentNeedsInputAlert(source, agentState)
    ? settings.agentNeedsInput
    : settings.agentTaskComplete
}
