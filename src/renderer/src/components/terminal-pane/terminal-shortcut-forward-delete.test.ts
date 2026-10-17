import { describe, expect, it } from 'vitest'
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

describe('Option/Alt + Forward-Delete (⌥⌦)', () => {
  it('translates Option+Delete to readline forward-kill-word on macOS', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', altKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1bd' })
  })

  it('translates Alt+Delete to readline forward-kill-word on non-mac', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', altKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bd' })
  })

  it('defers to xterm when Kitty keyboard protocol is active', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', altKey: true }),
        true,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toBeNull()
  })

  it('does not translate numpad delete when Alt is pressed', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'NumpadDecimal', altKey: true }),
        true
      )
    ).toBeNull()
  })

  it('does not interfere with plain Delete or other modifiers', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete' }),
        true
      )
    ).toBeNull()

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', metaKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x0b' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Delete', code: 'Delete', ctrlKey: true, altKey: true }),
        true
      )
    ).toBeNull()
  })
})
