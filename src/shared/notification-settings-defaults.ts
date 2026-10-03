import type { NotificationSettings } from './notification-settings-types'

export function getDefaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    cliWorktreeTaskComplete: true,
    automationWorktreeTaskComplete: true,
    terminalBell: false,
    suppressWhenFocused: true,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 100
  }
}
