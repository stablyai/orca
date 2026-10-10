import type { ITerminalOptions } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  NativeTerminalAppearance,
  NativeTerminalTheme
} from '../../../../../shared/native-terminal-appearance'

const THEME_KEYS: readonly (keyof NativeTerminalTheme)[] = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
]

function macOptionAsAlt(
  setting: GlobalSettings['terminalMacOptionAsAlt'] | undefined,
  macOptionIsMeta: boolean | undefined
): NativeTerminalAppearance['macOptionAsAlt'] {
  // Why: 'auto' was already resolved against the keyboard layout into xterm's macOptionIsMeta.
  if (setting === 'left' || setting === 'right') {
    return setting
  }
  return macOptionIsMeta ? 'true' : 'false'
}

// Built from the pane's live xterm options so the native view draws what xterm would.
export function buildNativeTerminalAppearance(
  options: ITerminalOptions,
  settings: GlobalSettings | null | undefined
): NativeTerminalAppearance {
  const theme: NativeTerminalTheme = {}
  for (const key of THEME_KEYS) {
    const value = options.theme?.[key]
    if (typeof value === 'string') {
      theme[key] = value
    }
  }
  return {
    fontFamily: options.fontFamily ?? 'monospace',
    fontSize: options.fontSize ?? 13,
    lineHeight: options.lineHeight ?? 1,
    letterSpacing: options.letterSpacing ?? 0,
    cursorStyle: options.cursorStyle ?? 'block',
    cursorBlink: options.cursorBlink === true,
    scrollback: options.scrollback ?? 1000,
    macOptionAsAlt: macOptionAsAlt(settings?.terminalMacOptionAsAlt, options.macOptionIsMeta),
    drawBoldTextInBrightColors: options.drawBoldTextInBrightColors !== false,
    minimumContrastRatio: options.minimumContrastRatio ?? 1,
    mouseHideWhileTyping: settings?.terminalMouseHideWhileTyping === true,
    copyOnSelect: settings?.terminalClipboardOnSelect === true,
    // The native view covers xterm's own element, which already sits inside the pane padding.
    paddingX: 0,
    paddingY: 0,
    theme
  }
}
