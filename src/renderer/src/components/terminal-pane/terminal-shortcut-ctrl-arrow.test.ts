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

describe('non-mac Ctrl+Left/Right word-nav', () => {
  // Windows Terminal, GNOME Terminal, and Konsole all bind Ctrl+←/→ to
  // word-nav. xterm.js emits \e[1;5D / \e[1;5C which default readline doesn't
  // map, so translate to \eb / \ef (same bytes as our Alt+Arrow rule).
  it('translates Ctrl+←/→ on Windows/Linux to readline \\eb / \\ef', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
  })

  it('does not translate Ctrl+Arrow on macOS (reserved by OS)', () => {
    // Mac uses Cmd+Arrow for line-nav and Option+Arrow for word-nav.
    // Ctrl+Arrow is the macOS Mission Control / Spaces chord.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }),
        true
      )
    ).toBeNull()
  })

  it('does not intercept Ctrl+Shift+Arrow (selection passthrough)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toBeNull()
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toBeNull()
  })

  it('does not intercept Ctrl+Alt+Arrow (different chord)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toBeNull()
  })
})
