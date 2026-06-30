import { describe, expect, it } from 'vitest'
import {
  shouldBypassXtermKeyboardEvent,
  shouldSuppressTerminalImeKeyboardEvent,
  type XtermBypassEvent
} from './xterm-bypass-policy'

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

  it('bubbles Cmd+V so web clients receive the native paste event', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'v', code: 'KeyV', metaKey: true }), noSel)
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
    // Why: this policy is narrowly scoped to clipboard chords. Cmd+F, Cmd+D,
    // Cmd+K, Cmd+W, Cmd+Arrow, Cmd+Backspace are handled in keyboard-handlers.ts
    // with stopImmediatePropagation before xterm's textarea listener fires.
    // Cmd+A flows through xterm's legacy evaluator which correctly produces
    // type=1 (selectAll), so we must not swallow it here.
    const cases = [
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

describe('shouldSuppressTerminalImeKeyboardEvent — macOS', () => {
  it('suppresses keyboard events while Chromium reports active IME composition', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Backspace', code: 'Backspace', isComposing: true })
      )
    ).toBe(true)
  })

  it('suppresses Windows IME Process keys', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'Process', code: 'KeyN', keyCode: 229 }))
    ).toBe(true)
  })

  it('does not suppress ordinary Backspace outside IME composition', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'Backspace', code: 'Backspace' }))
    ).toBe(false)
  })

  it('suppresses IME-owned editing keys while composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'Backspace', code: 'Backspace' }), {
        compositionActive: true
      })
    ).toBe(true)
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'ArrowDown', code: 'ArrowDown' }), {
        compositionActive: true
      })
    ).toBe(true)
  })

  it('does not suppress ordinary text keys solely because composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'a', code: 'KeyA' }), {
        compositionActive: true
      })
    ).toBe(false)
  })

  it('does not suppress keypress events because they carry committed text', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ type: 'keypress', key: '中', code: '', isComposing: true })
      )
    ).toBe(false)
  })
})
