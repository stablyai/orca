import type { GlobalSettings } from '../../../../shared/types'

export const SETTING_LABELS: Partial<Record<keyof GlobalSettings, string>> = {
  terminalFontSize: 'Font Size',
  terminalFontFamily: 'Font Family',
  terminalFontWeight: 'Font Weight',
  terminalBackgroundOpacity: 'Background Opacity',
  terminalCursorStyle: 'Cursor Style',
  terminalCursorBlink: 'Cursor Blink',
  terminalCursorOpacity: 'Cursor Opacity',
  terminalMouseHideWhileTyping: 'Mouse Hide While Typing',
  terminalWordSeparator: 'Word Separator',
  terminalFocusFollowsMouse: 'Focus Follows Mouse',
  terminalColorOverrides: 'Color Overrides',
  terminalMacOptionAsAlt: 'Option as Alt',
  terminalPaddingX: 'Padding X',
  terminalPaddingY: 'Padding Y',
  terminalDividerColorDark: 'Divider Color (Dark)',
  terminalDividerColorLight: 'Divider Color (Light)',
  terminalInactivePaneOpacity: 'Inactive Pane Opacity',
  windowBackgroundBlur: 'Window Background Blur'
}
