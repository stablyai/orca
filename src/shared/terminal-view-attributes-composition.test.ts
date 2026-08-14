import { describe, expect, it } from 'vitest'
import { composeTerminalViewAttributes } from './terminal-view-attributes-composition'

const cursorSettings = {
  terminalCursorStyle: 'block' as const,
  terminalCursorBlink: true
}

describe('composeTerminalViewAttributes (shared)', () => {
  it('resolves a null theme to the xterm ThemeService defaults', () => {
    const attrs = composeTerminalViewAttributes(null, 'dark', cursorSettings)
    expect(attrs.foreground).toEqual([0xff, 0xff, 0xff])
    expect(attrs.background).toEqual([0x00, 0x00, 0x00])
    expect(attrs.ansi).toHaveLength(256)
    expect(attrs.colorSchemeMode).toBe('dark')
  })
})
