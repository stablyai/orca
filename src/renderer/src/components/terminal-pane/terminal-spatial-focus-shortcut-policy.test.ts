import { describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../../../shared/keybindings'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

const SPATIAL_ACTIONS = [
  'terminal.focusPaneLeft',
  'terminal.focusPaneRight',
  'terminal.focusPaneUp',
  'terminal.focusPaneDown'
] as const

describe('spatial pane focus shortcut policy', () => {
  it('defaults to Mod+Alt+Arrow on every platform (Cmd+Opt on macOS)', () => {
    expect(getEffectiveKeybindingsForAction('terminal.focusPaneLeft', 'darwin')).toEqual([
      'Mod+Alt+ArrowLeft'
    ])
    expect(getEffectiveKeybindingsForAction('terminal.focusPaneRight', 'darwin')).toEqual([
      'Mod+Alt+ArrowRight'
    ])
    expect(getEffectiveKeybindingsForAction('terminal.focusPaneUp', 'darwin')).toEqual([
      'Mod+Alt+ArrowUp'
    ])
    expect(getEffectiveKeybindingsForAction('terminal.focusPaneDown', 'darwin')).toEqual([
      'Mod+Alt+ArrowDown'
    ])
    for (const actionId of SPATIAL_ACTIONS) {
      expect(getEffectiveKeybindingsForAction(actionId, 'linux')).toEqual(
        getEffectiveKeybindingsForAction(actionId, 'darwin')
      )
      expect(getEffectiveKeybindingsForAction(actionId, 'win32')).toEqual(
        getEffectiveKeybindingsForAction(actionId, 'darwin')
      )
    }
  })

  it('resolves the default Mod+Alt+Arrow chords to spatial focus', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, altKey: true }),
        true
      )
    ).toEqual({ type: 'focusPane', direction: 'left' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }),
        true
      )
    ).toEqual({ type: 'focusPane', direction: 'right' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true }),
        true
      )
    ).toEqual({ type: 'focusPane', direction: 'up' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true }),
        true
      )
    ).toEqual({ type: 'focusPane', direction: 'down' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toEqual({ type: 'focusPane', direction: 'left' })
  })

  it('does not claim vim-style Ctrl+H/J/K/L as spatial focus until the user binds them', () => {
    const vimChords = [
      event({ key: 'h', code: 'KeyH', ctrlKey: true }),
      event({ key: 'j', code: 'KeyJ', ctrlKey: true }),
      event({ key: 'k', code: 'KeyK', ctrlKey: true }),
      event({ key: 'l', code: 'KeyL', ctrlKey: true })
    ]

    for (const input of vimChords) {
      const mac = resolveTerminalShortcutAction(input, true)
      const linux = resolveTerminalShortcutAction(input, false)
      expect(
        mac?.type === 'focusPane' && mac.direction !== 'next' && mac.direction !== 'previous'
      ).toBe(false)
      expect(
        linux?.type === 'focusPane' && linux.direction !== 'next' && linux.direction !== 'previous'
      ).toBe(false)
    }
  })

  it('resolves a user-bound chord to the matching spatial focus action', () => {
    const keybindings = {
      'terminal.focusPaneLeft': ['Ctrl+H'],
      'terminal.focusPaneDown': ['Ctrl+J'],
      'terminal.focusPaneUp': ['Ctrl+K'],
      'terminal.focusPaneRight': ['Ctrl+L']
    }

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'h', code: 'KeyH', ctrlKey: true }),
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'focusPane', direction: 'left' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'j', code: 'KeyJ', ctrlKey: true }),
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'focusPane', direction: 'down' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'k', code: 'KeyK', ctrlKey: true }),
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'focusPane', direction: 'up' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'l', code: 'KeyL', ctrlKey: true }),
        true,
        'false',
        0,
        false,
        keybindings
      )
    ).toEqual({ type: 'focusPane', direction: 'right' })
  })

  it('leaves Cmd+[ / Cmd+] on the sequential cycle', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: '[', code: 'BracketLeft', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'previous' })
    expect(
      resolveTerminalShortcutAction(event({ key: ']', code: 'BracketRight', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'next' })
  })
})
