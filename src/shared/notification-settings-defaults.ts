import type { NotificationSettings } from './notification-settings-types'

export function getDefaultNotificationSettings(): NotificationSettings {
  return {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: false,
    suppressWhenFocused: true,
    showChildWorktreeUnread: true,
    customSoundId: 'system',
    customSoundPath: null,
    customSoundVolume: 100
  }
}
