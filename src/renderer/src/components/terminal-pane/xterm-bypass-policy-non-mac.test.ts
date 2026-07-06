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

describe('shouldSuppressTerminalImeKeyboardEvent — Windows/Linux', () => {
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

  it('does NOT suppress IME-owned editing keys on non-Mac (no CJK input-source gate)', () => {
    // Why: without a CJK input-source or CJK composition-text signal, inline
    // composition keys must reach xterm. The Windows IME Process-key path
    // (keyCode 229) still covers active preedit.
    for (const key of ['Backspace', 'Enter', 'ArrowDown']) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(event({ key, code: key }), {
          compositionActive: true,
          isCjkCompositionActive: false
        })
      ).toBe(false)
    }
  })

  it('suppresses IME-owned editing keys when CJK composition text is active', () => {
    // Why: non-Mac has no input-source bridge. CJK script in the preedit text is
    // the platform-neutral signal that candidate-window editing owns these keys.
    for (const key of ['Backspace', 'Enter', 'ArrowDown']) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(event({ key, code: key }), {
          compositionActive: true,
          isCjkCompositionActive: true
        })
      ).toBe(true)
    }
  })

  it('still suppresses universal Chromium IME signals regardless of CJK gate', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'Backspace', isComposing: true }), {
        compositionActive: false,
        isCjkCompositionActive: false
      })
    ).toBe(true)
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        {
          compositionActive: true,
          isCjkCompositionActive: false
        }
      )
    ).toBe(true)
  })

  it('does not suppress ordinary text keys solely because composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'a', code: 'KeyA' }), {
        compositionActive: true,
        isCjkCompositionActive: false
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
