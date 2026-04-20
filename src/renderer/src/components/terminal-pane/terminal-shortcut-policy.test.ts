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

describe('resolveTerminalShortcutAction', () => {
  it('preserves macOS readline ctrl chords for the shell', () => {
    const passthroughCases = [
      event({ key: 'r', code: 'KeyR', ctrlKey: true }),
      event({ key: 'u', code: 'KeyU', ctrlKey: true }),
      event({ key: 'e', code: 'KeyE', ctrlKey: true }),
      event({ key: 'a', code: 'KeyA', ctrlKey: true }),
      event({ key: 'w', code: 'KeyW', ctrlKey: true }),
      event({ key: 'k', code: 'KeyK', ctrlKey: true })
    ]

    for (const input of passthroughCases) {
      expect(resolveTerminalShortcutAction(input, true)).toBeNull()
    }
  })

  it('resolves the explicit macOS terminal shortcut allowlist', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'f', code: 'KeyF', metaKey: true }), true)
    ).toEqual({
      type: 'toggleSearch'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'k', code: 'KeyK', metaKey: true }), true)
    ).toEqual({
      type: 'clearActivePane'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'w', code: 'KeyW', metaKey: true }), true)
    ).toEqual({
      type: 'closeActivePane'
    })
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', metaKey: true }), true)
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }),
        true
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })
    expect(
      resolveTerminalShortcutAction(event({ key: '[', code: 'BracketLeft', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'previous' })
    expect(
      resolveTerminalShortcutAction(event({ key: ']', code: 'BracketRight', metaKey: true }), true)
    ).toEqual({ type: 'focusPane', direction: 'next' })
  })

  it('keeps shift-enter and delete helpers explicit', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'Enter', code: 'Enter', shiftKey: true }), true)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[13;2u'
    })
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', ctrlKey: true }), true)).toEqual(
      { type: 'sendInput', data: '\x17' }
    )
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', metaKey: true }), true)).toEqual(
      { type: 'sendInput', data: '\x15' }
    )
    expect(resolveTerminalShortcutAction(event({ key: 'Delete', metaKey: true }), true)).toEqual({
      type: 'sendInput',
      data: '\x0b'
    })
    expect(resolveTerminalShortcutAction(event({ key: 'Backspace', altKey: true }), true)).toEqual({
      type: 'sendInput',
      data: '\x1b\x7f'
    })
  })

  it('translates Cmd+←/→ on macOS to readline start/end-of-line (Ctrl+A/E)', () => {
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x01' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x05' })

    // Cmd+Shift+Arrow is a different chord (selection) — don't intercept.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()
  })

  it('uses ctrl as the non-mac pane modifier but still requires shift for tab-safe chords', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'f', code: 'KeyF', ctrlKey: true }), false)
    ).toEqual({ type: 'toggleSearch' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'copySelection' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'r', code: 'KeyR', ctrlKey: true }), false)
    ).toBeNull()
  })

  it('lets Ctrl+D pass through as EOF on non-Mac, requires Shift for split (#586)', () => {
    // Ctrl+D without Shift on Windows/Linux must NOT trigger split — it's EOF
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', ctrlKey: true }), false)
    ).toBeNull()

    // Ctrl+Shift+D on Windows/Linux splits the pane right (vertical)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })

    // Alt+Shift+D on Windows/Linux splits the pane down (horizontal)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        false
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })

    // Alt+Shift+D should NOT trigger split-down on Mac (Mac uses Cmd+Shift+D)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    // Alt+D (no Shift) on Windows/Linux must pass through for readline forward-word-delete
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', altKey: true }), false)
    ).toBeNull()
  })

  it('translates alt+arrow to readline word-nav escapes on both platforms', () => {
    // macOS: option+←/→ → \eb / \ef (readline backward-word / forward-word)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
        true
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })

    // Linux/Windows: alt+←/→ produces the same escapes (platform-agnostic chord)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
        false
      )
    ).toEqual({ type: 'sendInput', data: '\x1bf' })

    // alt+shift+arrow is a different chord (select-word in some shells) — don't
    // intercept, let xterm.js / the shell handle it.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true }),
        true
      )
    ).toBeNull()

    // alt+ctrl+arrow is a different chord entirely — passthrough.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, ctrlKey: true }),
        true
      )
    ).toBeNull()

    // Ctrl+Alt+Arrow (Linux workspace switching on some desktops) must pass through on non-Mac.
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, altKey: true }),
        false
      )
    ).toBeNull()

    // Regression guard: plain ArrowLeft must still pass through untouched.
    expect(
      resolveTerminalShortcutAction(event({ key: 'ArrowLeft', code: 'ArrowLeft' }), true)
    ).toBeNull()
  })

  it('translates macOS Option+B/F/D to readline escape sequences in compose mode', () => {
    // With macOptionAsAlt='false' (compose), xterm.js doesn't translate these.
    // Matches on event.code because macOS composition replaces event.key.
    expect(
      resolveTerminalShortcutAction(event({ key: '∫', code: 'KeyB', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveTerminalShortcutAction(event({ key: 'ƒ', code: 'KeyF', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bf' })
    expect(
      resolveTerminalShortcutAction(event({ key: '∂', code: 'KeyD', altKey: true }), true, 'false')
    ).toEqual({ type: 'sendInput', data: '\x1bd' })

    // On Linux/Windows, Alt+B/F/D must still pass through
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), false)
    ).toBeNull()

    // Option+Shift+B/F/D should not be intercepted (different chord)
    expect(
      resolveTerminalShortcutAction(
        event({ key: 'B', code: 'KeyB', altKey: true, shiftKey: true }),
        true,
        'false'
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when left Option acts as alt', () => {
    // Left Option (optionKeyLocation=1) in 'left' mode: full Meta for any letter key
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })
    expect(
      resolveTerminalShortcutAction(
        event({ key: '†', code: 'KeyT', altKey: true }),
        true,
        'left',
        1
      )
    ).toEqual({ type: 'sendInput', data: '\x1bt' })

    // Right Option (optionKeyLocation=2) in 'left' mode: compose side, only B/F/D patched
    expect(
      resolveTerminalShortcutAction(
        event({ key: '∫', code: 'KeyB', altKey: true }),
        true,
        'left',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    // Right Option+L should pass through (compose character)
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'left',
        2
      )
    ).toBeNull()
  })

  it('sends Esc+letter for any Option+letter when right Option acts as alt', () => {
    // Right Option (optionKeyLocation=2) in 'right' mode: full Meta, including punctuation
    expect(
      resolveTerminalShortcutAction(
        event({ key: '≥', code: 'Period', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1b.' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1bl' })

    // Left Option (optionKeyLocation=1) in 'right' mode: compose side, only B/F/D patched
    expect(
      resolveTerminalShortcutAction(
        event({ key: '¬', code: 'KeyL', altKey: true }),
        true,
        'right',
        1
      )
    ).toBeNull()
  })

  it('does not intercept Option+letter in true mode (xterm handles it)', () => {
    // In 'true' mode, macOptionIsMeta is enabled in xterm, so no compensation needed
    // Our handler still fires but is gated by macOptionAsAlt !== 'true'
    expect(
      resolveTerminalShortcutAction(event({ key: 'b', code: 'KeyB', altKey: true }), true, 'true')
    ).toBeNull()
  })

  it('keeps Cmd+D and Cmd+Shift+D for split on macOS', () => {
    expect(
      resolveTerminalShortcutAction(event({ key: 'd', code: 'KeyD', metaKey: true }), true)
    ).toEqual({ type: 'splitActivePane', direction: 'vertical' })

    expect(
      resolveTerminalShortcutAction(
        event({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }),
        true
      )
    ).toEqual({ type: 'splitActivePane', direction: 'horizontal' })
  })
})
