import { describe, expect, it } from 'vitest'

import {
  computerUseClickModifiersValidationMessage,
  computerUseHotkeyValidationMessage,
  computerUsePressKeyValidationMessage
} from './computer-use-key-spec'

describe('computer-use key specs', () => {
  it('accepts hotkeys with modifiers and one key', () => {
    expect(computerUseHotkeyValidationMessage('CmdOrCtrl+A')).toBeNull()
    expect(computerUseHotkeyValidationMessage('ctrl+shift+p')).toBeNull()
    expect(computerUseHotkeyValidationMessage('CommandOrControl + Option + Space')).toBeNull()
  })

  it('rejects single keys, modifier-only chords, empty parts, and multiple base keys', () => {
    const expected = expect.stringContaining('Hotkey requires a modifier and one key')

    expect(computerUseHotkeyValidationMessage('Return')).toEqual(expected)
    expect(computerUseHotkeyValidationMessage('CmdOrCtrl+Shift')).toEqual(expected)
    expect(computerUseHotkeyValidationMessage('Ctrl++A')).toEqual(expected)
    expect(computerUseHotkeyValidationMessage('Ctrl+A+B')).toEqual(expected)
  })

  it('accepts single press keys including literal plus', () => {
    expect(computerUsePressKeyValidationMessage('Return')).toBeNull()
    expect(computerUsePressKeyValidationMessage('PageUp')).toBeNull()
    expect(computerUsePressKeyValidationMessage('+')).toBeNull()
  })

  it('rejects modifier chords on the press-key path', () => {
    const expected = expect.stringContaining('Press-key accepts one key only')

    expect(computerUsePressKeyValidationMessage('CmdOrCtrl+V')).toEqual(expected)
    expect(computerUsePressKeyValidationMessage('Ctrl+Shift+P')).toEqual(expected)
    expect(computerUsePressKeyValidationMessage('')).toEqual(expected)
  })

  it('accepts modifier-only click chords', () => {
    expect(computerUseClickModifiersValidationMessage('CmdOrCtrl')).toBeNull()
    expect(computerUseClickModifiersValidationMessage('CmdOrCtrl+Shift')).toBeNull()
    expect(computerUseClickModifiersValidationMessage('Control + Alt')).toBeNull()
  })

  it('rejects empty, key-bearing, and malformed click modifier chords', () => {
    const expected = expect.stringContaining('Click modifiers accept modifier keys only')

    expect(computerUseClickModifiersValidationMessage('')).toEqual(expected)
    expect(computerUseClickModifiersValidationMessage('CmdOrCtrl+A')).toEqual(expected)
    expect(computerUseClickModifiersValidationMessage('Cmd-Or-Ctrl')).toEqual(expected)
    expect(computerUseClickModifiersValidationMessage('Ctrl++Shift')).toEqual(expected)
    expect(computerUseClickModifiersValidationMessage('Ctrl+Shift+Alt+Meta+Super')).toEqual(
      expected
    )
  })
})
