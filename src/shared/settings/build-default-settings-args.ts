import type { GlobalSettings } from './global-settings-types'
import type { NotificationSettings } from '../notifications/notification-settings-types'
import type { VoiceSettings } from '../speech/speech-types'

export type BuildDefaultSettingsArgs = {
  workspaceDir: string
  appFontFamily: string
  editorAutoSaveDelayMs: number
  primarySelectionMiddleClickPaste: boolean
  primarySelectionDefaultedForLinux: boolean
  terminalFontFamily: string
  terminalFontWeight: number
  terminalFontWeightWindowsRegular?: GlobalSettings['terminalFontWeightWindowsRegular']
  terminalInactivePaneOpacity: number
  terminalRightClickToPaste: boolean
  notifications: NotificationSettings
  voice: VoiceSettings
}
