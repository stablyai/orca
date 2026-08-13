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

describe('terminal split shortcuts', () => {
  it('keeps Cmd+D and Cmd+Shift+D for split on macOS', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', metaKey: true }), true)
    ).toEqual({ type: 'splitActivePane', direction: 'vertical', position: 'after' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }),
        true
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal', position: 'after' })
  })

  it('resolves split left/up to a leading split once the user binds a chord', () => {
    // Why: both actions ship unbound, so only an override can reach them.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, altKey: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.splitLeft': ['Mod+Alt+D'] }
      )
    ).toEqual({ type: 'splitActivePane', direction: 'vertical', position: 'before' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, altKey: true, shiftKey: true }),
        true,
        'false',
        0,
        false,
        { 'terminal.splitUp': ['Mod+Alt+Shift+D'] }
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal', position: 'before' })
  })

  it('leaves split left/up unbound by default so no chord is stolen from the shell', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, altKey: true }),
        true
      )
    ).toBeNull()
  })
})
