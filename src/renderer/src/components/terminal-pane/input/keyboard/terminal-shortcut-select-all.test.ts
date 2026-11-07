import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: 'a',
    code: 'KeyA',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('terminal select-all shortcut', () => {
  it('uses Cmd+A on macOS', () => {
    expect(resolveTerminalShortcutAction(event({ metaKey: true }), true)).toEqual({
      type: 'selectAll'
    })
    expect(resolveTerminalShortcutAction(event({ metaKey: true, repeat: true }), true)).toEqual({
      type: 'selectAll'
    })
  })

  it('uses Ctrl+Shift+A without stealing bare Ctrl+A off macOS', () => {
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true, shiftKey: true }), false)).toEqual({
      type: 'selectAll'
    })
    expect(resolveTerminalShortcutAction(event({ ctrlKey: true }), false)).toBeNull()
  })
})
