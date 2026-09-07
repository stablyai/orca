import type { GlobalSettings } from './global-settings-types'
import { getDefaultNotificationSettings, getDefaultVoiceSettings } from './constants'
import { buildDefaultSettings } from './default-global-settings'

// Why: tests need a complete GlobalSettings without hand-copying every field, so
// new settings only have to be added to buildDefaultSettings, not each fixture.
export function createGlobalSettingsFixture(
  overrides: Partial<GlobalSettings> = {}
): GlobalSettings {
  return {
    ...buildDefaultSettings({
      // Callers supply the real directory; no platform-specific default belongs here.
      workspaceDir: overrides.workspaceDir ?? '',
      appFontFamily: 'Geist',
      editorAutoSaveDelayMs: 1000,
      primarySelectionMiddleClickPaste: false,
      primarySelectionDefaultedForLinux: false,
      terminalFontFamily: 'JetBrains Mono',
      terminalInactivePaneOpacity: 0.5,
      terminalRightClickToPaste: false,
      notifications: getDefaultNotificationSettings(),
      voice: getDefaultVoiceSettings()
    }),
    ...overrides
  }
}
