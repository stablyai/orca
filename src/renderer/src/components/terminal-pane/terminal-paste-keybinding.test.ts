import { describe, expect, it } from 'vitest'
import { keybindingCatalog } from '../../../../shared/keybindings/keybinding-catalog'
import { buildEffectiveKeymap } from '../../../../shared/keybindings/effective-keymap'
import { isTerminalPasteKeybinding } from './terminal-paste-keybinding'

describe('isTerminalPasteKeybinding', () => {
  it('should match Linux paste defaults from the Effective Keymap', () => {
    const keymap = buildEffectiveKeymap({ catalog: keybindingCatalog, platform: 'linux' })

    expect(
      isTerminalPasteKeybinding(event({ key: 'v', code: 'KeyV', ctrlKey: true }), keymap)
    ).toBe(true)
    expect(
      isTerminalPasteKeybinding(
        event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
        keymap
      )
    ).toBe(true)
    expect(
      isTerminalPasteKeybinding(event({ key: 'Insert', code: 'Insert', shiftKey: true }), keymap)
    ).toBe(true)
  })

  it('should stop matching a default chord after the user replaces the Chord Set', () => {
    const keymap = buildEffectiveKeymap({
      catalog: keybindingCatalog,
      platform: 'linux',
      overrides: { 'terminal.paste': 'ctrl+shift+v' }
    })

    expect(
      isTerminalPasteKeybinding(event({ key: 'v', code: 'KeyV', ctrlKey: true }), keymap)
    ).toBe(false)
    expect(
      isTerminalPasteKeybinding(
        event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
        keymap
      )
    ).toBe(true)
  })
})

function event(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  } as KeyboardEvent
}
