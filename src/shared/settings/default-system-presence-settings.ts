import type { GlobalSettings } from './global-settings-types'

export const DEFAULT_SYSTEM_PRESENCE_SETTINGS = {
  minimizeToTrayOnClose: false,
  // Stored on every platform; only the macOS desktop creates these indicators.
  showMenuBarIcon: true,
  showNotchAgentStatus: true
} satisfies Pick<
  GlobalSettings,
  'minimizeToTrayOnClose' | 'showMenuBarIcon' | 'showNotchAgentStatus'
>
