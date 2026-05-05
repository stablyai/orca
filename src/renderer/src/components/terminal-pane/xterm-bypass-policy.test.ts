import { describe, expect, it } from 'vitest'
import { shouldBypassXtermKeydown, type XtermBypassEvent } from './xterm-bypass-policy'

function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
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

describe('shouldBypassXtermKeydown — macOS', () => {
  const opts = { isMac: true, hasSelection: true }
  const noSel = { isMac: true, hasSelection: false }

  it('bubbles Cmd+C so Chromium copy fires and xterm populates clipboard', () => {
    // Why: this is the whole point of the policy. When kitty progressive
    // enhancement is on, the default xterm path CSI-u encodes Cmd+C and
    // preventDefaults the keydown, suppressing the browser copy event.
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', metaKey: true }), opts)).toBe(
      true
    )
  })

  it('bubbles Cmd+C even with no selection (no-op copy is harmless on macOS)', () => {
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', metaKey: true }), noSel)).toBe(
      true
    )
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
      expect(shouldBypassXtermKeydown(e, opts)).toBe(false)
    }
  })

  it('bubbles already-handled Cmd app shortcuts so kitty does not also write to shell', () => {
    // Why: some window-level shortcuts call preventDefault without stopping
    // propagation. VS Code returns false for resolved Meta keybindings for the
    // same kitty reason: app shortcuts must not also become terminal input.
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'b', code: 'KeyB', defaultPrevented: true, metaKey: true }),
        opts
      )
    ).toBe(true)
    expect(
      shouldBypassXtermKeydown(
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
      shouldBypassXtermKeydown(
        event({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble Ctrl chords — those must reach the shell', () => {
    // Ctrl+C is SIGINT, Ctrl+D is EOF, etc. — xterm must see them.
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', ctrlKey: true }), opts)).toBe(
      false
    )
    expect(shouldBypassXtermKeydown(event({ key: 'd', code: 'KeyD', ctrlKey: true }), opts)).toBe(
      false
    )
  })

  it('does not bubble Cmd+Ctrl combos (unusual; defer to xterm)', () => {
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'c', code: 'KeyC', metaKey: true, ctrlKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble already-handled Ctrl chords on macOS', () => {
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'c', code: 'KeyC', defaultPrevented: true, ctrlKey: true }),
        opts
      )
    ).toBe(false)
  })

  it('does not bubble plain letters — those are normal input', () => {
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC' }), opts)).toBe(false)
  })
})

describe('shouldBypassXtermKeydown — Windows/Linux', () => {
  const withSel = { isMac: false, hasSelection: true }
  const noSel = { isMac: false, hasSelection: false }

  it('bubbles Ctrl+Shift+C (standard terminal copy on Linux/Windows)', () => {
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('bubbles Ctrl+C only when there is a selection (otherwise SIGINT)', () => {
    // Why: bare Ctrl+C without a selection must reach the shell as SIGINT.
    // With a selection, terminals like Windows Terminal copy instead.
    expect(
      shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', ctrlKey: true }), withSel)
    ).toBe(true)
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', ctrlKey: true }), noSel)).toBe(
      false
    )
  })

  it('bubbles Ctrl+V and Ctrl+Shift+V for paste', () => {
    expect(shouldBypassXtermKeydown(event({ key: 'v', code: 'KeyV', ctrlKey: true }), noSel)).toBe(
      true
    )
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }),
        noSel
      )
    ).toBe(true)
  })

  it('bubbles Shift+Insert (X11/Linux paste convention)', () => {
    expect(
      shouldBypassXtermKeydown(event({ key: 'Insert', code: 'Insert', shiftKey: true }), noSel)
    ).toBe(true)
  })

  it('does not bubble plain Ctrl letter chords — shell shortcuts must reach PTY', () => {
    // Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+R, Ctrl+L — all readline-critical.
    for (const keyCode of ['a', 'e', 'u', 'r', 'l']) {
      expect(
        shouldBypassXtermKeydown(
          event({ key: keyCode, code: `Key${keyCode.toUpperCase()}`, ctrlKey: true }),
          noSel
        )
      ).toBe(false)
    }
  })

  it('bubbles already-handled Ctrl app shortcuts so kitty does not also write to shell', () => {
    expect(
      shouldBypassXtermKeydown(
        event({ key: 'b', code: 'KeyB', defaultPrevented: true, ctrlKey: true }),
        noSel
      )
    ).toBe(true)
    expect(
      shouldBypassXtermKeydown(
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
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC' }), noSel)).toBe(false)
  })

  it('does not bubble Cmd chords on non-Mac (Super+C has no clipboard meaning there)', () => {
    expect(shouldBypassXtermKeydown(event({ key: 'c', code: 'KeyC', metaKey: true }), noSel)).toBe(
      false
    )
  })
})
