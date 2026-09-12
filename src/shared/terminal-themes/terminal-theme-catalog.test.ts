import { describe, expect, it } from 'vitest'
import {
  BUILTIN_TERMINAL_THEME_NAMES,
  getBuiltinTerminalThemePalette,
  TERMINAL_THEME_CATALOG
} from './index'

// The keys mobile's WebView whitelists — it copies only Object.keys(DEFAULT_TERMINAL_THEME)
// (mobile/src/terminal/terminal-webview-html.ts) off the pushed palette, so a theme missing one
// of these renders half Tokyo Night on the phone while looking correct on desktop.
const MOBILE_WEBVIEW_THEME_KEYS = [
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
].sort()

describe('built-in terminal theme catalog', () => {
  it('lists all 30 built-ins in strictly ascending order', () => {
    expect(BUILTIN_TERMINAL_THEME_NAMES).toHaveLength(30)
    expect(Object.keys(TERMINAL_THEME_CATALOG)).toHaveLength(30)
    for (let index = 1; index < BUILTIN_TERMINAL_THEME_NAMES.length; index += 1) {
      const previous = BUILTIN_TERMINAL_THEME_NAMES[index - 1]
      const current = BUILTIN_TERMINAL_THEME_NAMES[index]
      expect(previous < current, `${previous} should sort before ${current}`).toBe(true)
    }
  })

  // The display name is the persisted id in GlobalSettings.terminalThemeDark/terminalThemeLight
  // (src/shared/constants.ts) and in the mobile slot storage; a rename orphans saved selections.
  it('keeps the two shipped default theme names verbatim', () => {
    expect(BUILTIN_TERMINAL_THEME_NAMES).toContain('Ghostty Default Style Dark')
    expect(BUILTIN_TERMINAL_THEME_NAMES).toContain('Builtin Tango Light')
  })

  it('resolves a palette for every catalogued name and null for an unknown one', () => {
    for (const name of BUILTIN_TERMINAL_THEME_NAMES) {
      expect(getBuiltinTerminalThemePalette(name), name).toBe(TERMINAL_THEME_CATALOG[name])
    }
    expect(getBuiltinTerminalThemePalette('No Such Terminal Theme')).toBeNull()
  })

  // Persisted selections and user-typed names must never resolve through Object.prototype.
  it('rejects prototype property names as theme ids', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(getBuiltinTerminalThemePalette(name), name).toBeNull()
      expect(Object.hasOwn(TERMINAL_THEME_CATALOG, name), name).toBe(false)
    }
  })

  it('defines exactly the mobile-whitelisted keys in every palette', () => {
    for (const name of BUILTIN_TERMINAL_THEME_NAMES) {
      expect(Object.keys(TERMINAL_THEME_CATALOG[name]).sort(), name).toEqual(
        MOBILE_WEBVIEW_THEME_KEYS
      )
    }
  })
})
