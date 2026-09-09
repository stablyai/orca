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

function resolveWindowsKitty(
  input: TerminalShortcutEvent,
  kittyKeyboardFlags = 1
): ReturnType<typeof resolveTerminalShortcutAction> {
  return resolveTerminalShortcutAction(
    input,
    false,
    'false',
    0,
    true,
    undefined,
    undefined,
    () => kittyKeyboardFlags
  )
}

describe('Windows/Linux Alt+letter in kitty panes', () => {
  it('reports alt+q as CSI-u so Pi dequeue reaches the TUI', () => {
    expect(resolveWindowsKitty(event({ key: 'q', code: 'KeyQ', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3u'
    })
  })

  it('leaves alt+q to xterm when kitty is inactive', () => {
    expect(resolveWindowsKitty(event({ key: 'q', code: 'KeyQ', altKey: true }), 0)).toBeNull()
  })

  it('does not rewrite alt+arrow (xterm already encodes CSI 1;3A/B)', () => {
    expect(resolveWindowsKitty(event({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }))).toBeNull()
    expect(
      resolveWindowsKitty(event({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }))
    ).toBeNull()
  })

  it('does not steal AltGr text (ctrl+alt)', () => {
    expect(
      resolveWindowsKitty(event({ key: 'q', code: 'KeyQ', altKey: true, ctrlKey: true }))
    ).toBeNull()
  })
})
