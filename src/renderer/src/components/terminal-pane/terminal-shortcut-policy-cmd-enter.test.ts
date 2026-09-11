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

describe('resolveTerminalShortcutAction Cmd+Enter', () => {
  it('submits Cmd+Enter on macOS, falling back to Alt+Enter without KKP', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', metaKey: true }), true)
    ).toEqual({ type: 'sendInput', data: '\x1b\r' })
  })

  it('sends Super+Enter CSI-u for Cmd+Enter on macOS while KKP is active', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'Enter', code: 'Enter', metaKey: true }),
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        () => 1
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[13;9u' })
  })

  it('does not treat Meta+Enter as submit off macOS (Meta is the Super key there)', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', metaKey: true }), false)
    ).toBeNull()
  })
})
