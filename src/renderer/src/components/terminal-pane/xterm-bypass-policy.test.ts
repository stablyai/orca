import { describe, expect, it } from 'vitest'
import { shouldBypassXtermKeyboardEvent, type XtermBypassEvent } from './xterm-bypass-policy'

function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('shouldBypassXtermKeyboardEvent — macOS', () => {
  const opts = { isMac: true, hasSelection: true }
  const noSel = { isMac: true, hasSelection: false }

  it('bubbles Cmd+C so Chromium copy fires and xterm populates clipboard', () => {
    // Why: this is the whole point of the policy. When kitty progressive
    // enhancement is on, the default xterm path CSI-u encodes Cmd+C and
    // preventDefaults the keydown, suppressing the browser copy event.
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', metaKey: true }), opts)
    ).toBe(true)
  })

  it('bubbles Cmd+C even with no selection (no-op copy is harmless on macOS)', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', metaKey: true }), noSel)
    ).toBe(true)
  })

  it('matches Cmd+C by produced logical key rather than physical key', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyJ', metaKey: true }), opts)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'j', code: 'KeyC', metaKey: true }), opts)
    ).toBe(false)
  })

  it('does NOT bubble other Cmd chords — Orca window handlers intercept them before xterm', () => {
    // Why: this policy is narrowly scoped to Cmd+C, the one clipboard chord
    // Orca does not intercept at the window level. Cmd+V, Cmd+F, Cmd+D, Cmd+K,
    // Cmd+W, Cmd+Arrow, Cmd+Backspace are all handled in keyboard-handlers.ts
    // with stopImmediatePropagation before xterm's textarea listener fires,
    // so they never reach this handler. Cmd+A flows through xterm's legacy
    // evaluator which correctly produces type=1 (selectAll), so we must not
    // swallow it here.
    const cases = [
      event({ key: 'v', code: 'KeyV', metaKey: true }),
      event({ key: 'a', code: 'KeyA', metaKey: true }),
      event({ key: 't', code: 'KeyT', metaKey: true })
    ]
    for (const e of cases) {
      expect(shouldBypassXtermKeyboardEvent(e, opts)).toBe(false)
    }
  })

  it('bubbles already-handled Cmd app shortcuts so kitty does not also write to shell', () => {
    // Why: some window-level shortcuts call preventDefault without stopping
    // propagation. App shortcuts must not also become terminal input.
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'b', code: 'KeyB', defaultPrevented: true, metaKey: true }),
        opts
      )
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          defaultPrevented: true,
          metaKey: true,
          altKey: true
        }),
        opts
      )
    ).toBe(true)
  })

  it('does not bubble Cmd+Shift+C — already intercepted in keyboard-handlers.ts', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble Ctrl chords — those must reach the shell', () => {
    // Ctrl+C is SIGINT, Ctrl+D is EOF, etc. — xterm must see them.
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), opts)
    ).toBe(false)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'd', code: 'KeyD', ctrlKey: true }), opts)
    ).toBe(false)
  })

  it('does not bubble Cmd+Ctrl combos (unusual; defer to xterm)', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'c', code: 'KeyC', metaKey: true, ctrlKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble already-handled Ctrl chords on macOS', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'c', code: 'KeyC', defaultPrevented: true, ctrlKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble plain letters — those are normal input', () => {
    expect(shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC' }), opts)).toBe(false)
  })

  it('bubbles Shift+non-ASCII printable text so the active keyboard layout wins', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'Ф', code: 'KeyA', shiftKey: true }), opts)
    ).toBe(true)
  })

  it('bubbles Shift+non-ASCII keyup so kitty does not emit a Latin release sequence', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keyup', key: 'Ф', code: 'KeyA', shiftKey: true }),
        opts
      )
    ).toBe(true)
  })

  it('does not bubble Shift+non-ASCII keypress because that carries the layout text', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keypress', key: 'Ф', code: 'KeyA', shiftKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble Shift+Latin printable text', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'A', code: 'KeyA', shiftKey: true }), opts)
    ).toBe(false)
  })
})

describe('shouldBypassXtermKeyboardEvent — Windows/Linux', () => {
  const withSel = { isMac: false, hasSelection: true }
  const noSel = { isMac: false, hasSelection: false }

  it('bubbles Ctrl+Shift+C (standard terminal copy on Linux/Windows)', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('matches Ctrl+Shift+C by produced logical key rather than physical key', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'C', code: 'KeyJ', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'J', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(false)
  })

  it('bubbles Ctrl+C only when there is a selection (otherwise SIGINT)', () => {
    // Why: bare Ctrl+C without a selection must reach the shell as SIGINT.
    // With a selection, terminals like Windows Terminal copy instead.
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), withSel)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), noSel)
    ).toBe(false)
  })

  it('matches Ctrl+C with selection by produced logical key rather than physical key', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyJ', ctrlKey: true }), withSel)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'j', code: 'KeyC', ctrlKey: true }), withSel)
    ).toBe(false)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyJ', ctrlKey: true }), noSel)
    ).toBe(false)
  })

  it('bubbles Ctrl+V and Ctrl+Shift+V for paste', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'v', code: 'KeyV', ctrlKey: true }), noSel)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('matches paste by produced logical key rather than physical key', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'v', code: 'KeyK', ctrlKey: true }), noSel)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'k', code: 'KeyV', ctrlKey: true }), noSel)
    ).toBe(false)
  })

  it('bubbles Shift+Insert (X11/Linux paste convention)', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'Insert', code: 'Insert', shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('does not bubble plain Ctrl letter chords — shell shortcuts must reach PTY', () => {
    // Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+R, Ctrl+L — all readline-critical.
    for (const keyCode of ['a', 'e', 'u', 'r', 'l']) {
      expect(
        shouldBypassXtermKeyboardEvent(
          event({ key: keyCode, code: `Key${keyCode.toUpperCase()}`, ctrlKey: true }),
          noSel
        )
      ).toBe(false)
    }
  })

  it('bubbles already-handled Ctrl app shortcuts so kitty does not also write to shell', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'b', code: 'KeyB', defaultPrevented: true, ctrlKey: true }),
        noSel
      )
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({
          key: 'ArrowLeft',
          code: 'ArrowLeft',
          defaultPrevented: true,
          ctrlKey: true,
          altKey: true
        }),
        noSel
      )
    ).toBe(true)
  })

  it('does not bubble plain letters', () => {
    expect(shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC' }), noSel)).toBe(false)
  })

  it('bubbles Shift+non-ASCII printable text so the active keyboard layout wins', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'Ф', code: 'KeyA', shiftKey: true }), noSel)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keyup', key: 'Ф', code: 'KeyA', shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('does not bubble unshifted non-ASCII printable text', () => {
    expect(shouldBypassXtermKeyboardEvent(event({ key: 'ф', code: 'KeyA' }), noSel)).toBe(false)
  })

  it('does not bubble Cmd chords on non-Mac (Super+C has no clipboard meaning there)', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyC', metaKey: true }), noSel)
    ).toBe(false)
  })
})
