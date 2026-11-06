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

describe('resolveTerminalShortcutAction Ctrl+M', () => {
  it('forwards Ctrl+M as the kitty CSI-u chord so Grok can toggle multiline', () => {
    // Why: Ctrl+M is historically CR (same as Enter). xterm collapses it to bare
    // CR, so Grok Build never sees a distinct toggle-multiline chord (#9736).
    expect(
      resolveTerminalShortcutAction(event({ key: 'm', code: 'KeyM', ctrlKey: true }), true)
    ).toEqual({ type: 'sendInput', data: '\x1b[109;5u' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'M', code: 'KeyM', ctrlKey: true }), false)
    ).toEqual({ type: 'sendInput', data: '\x1b[109;5u' })
    // Physical KeyM with a layout-remapped event.key still routes as Ctrl+M.
    expect(
      resolveTerminalShortcutAction(event({ key: 'Dead', code: 'KeyM', ctrlKey: true }), true)
    ).toEqual({ type: 'sendInput', data: '\x1b[109;5u' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'm', code: 'KeyM', ctrlKey: true }),
        false,
        'false',
        0,
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[109;5u' })
  })

  it('does not claim non-plain Ctrl+M chords', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'm', code: 'KeyM', ctrlKey: true, metaKey: true }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(event({ key: 'm', code: 'KeyM', ctrlKey: false }), true)
    ).toBeNull()
  })
})
