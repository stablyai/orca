import { describe, expect, it } from 'vitest'
import {
  shouldBypassXtermKeyboardEvent,
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

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
  const windowsIdle = {
    isMac: false,
    isLinux: false,
    compositionActive: false,
    candidateKeyGuardActive: false,
    pendingCandidateKeyReleaseActive: false
  }
  const linuxIdle = {
    isMac: false,
    isLinux: true,
    compositionActive: false,
    candidateKeyGuardActive: false,
    pendingCandidateKeyReleaseActive: false
  }
  const linuxComposing = { ...linuxIdle, compositionActive: true, candidateKeyGuardActive: true }
  // Post-compositionend guard: the tracker is already inactive but the
  // committing key's trailing press/release must still be absorbed.
  const linuxPostCompositionGuard = { ...linuxIdle, candidateKeyGuardActive: true }
  const windowsComposing = {
    ...windowsIdle,
    compositionActive: true,
    candidateKeyGuardActive: true
  }

  it('suppresses keyboard events while Chromium reports active IME composition', () => {
    for (const options of [windowsIdle, linuxIdle]) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ key: 'Backspace', code: 'Backspace', isComposing: true }),
          options
        )
      ).toBe(true)
    }
  })

  it('suppresses Windows IME Process keys', () => {
    // Why: Windows preedit can hit the textarea before compositionstart;
    // letting the 229 keydown through would flush it via xterm's textarea diff.
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        windowsIdle
      )
    ).toBe(true)
  })

  it('lets standalone Linux 229 keydowns reach xterm so its CompositionHelper can diff text', () => {
    // Why: Sogou/fcitx candidate commits can ride a bare 229 keydown outside a
    // composition session; xterm must see it to schedule its textarea diff.
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        linuxIdle
      )
    ).toBe(false)
  })

  it('suppresses Linux 229 keydowns while the composition tracker is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        linuxComposing
      )
    ).toBe(true)
  })

  it('suppresses 229 / Process keyups so kitty release reporting cannot leak', () => {
    for (const options of [windowsIdle, linuxIdle]) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keyup', key: 'Process', code: 'KeyN', keyCode: 229 }),
          options
        )
      ).toBe(true)
    }
  })

  it('does not suppress ordinary Backspace outside IME composition', () => {
    for (const options of [windowsIdle, linuxIdle]) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ key: 'Backspace', code: 'Backspace' }),
          options
        )
      ).toBe(false)
    }
  })

  it('suppresses IME-owned editing keys while composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Backspace', code: 'Backspace' }),
        linuxComposing
      )
    ).toBe(true)
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'ArrowDown', code: 'ArrowDown' }),
        linuxComposing
      )
    ).toBe(true)
  })

  it('does not suppress ordinary text keys solely because composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'a', code: 'KeyA' }), linuxComposing)
    ).toBe(false)
  })

  it('does not suppress keypress events because they carry committed text', () => {
    for (const options of [windowsIdle, linuxIdle]) {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keypress', key: '中', code: '', isComposing: true }),
          options
        )
      ).toBe(false)
    }
  })

  describe('candidate-selection keys (Sogou Space/digit commit)', () => {
    it('suppresses Space and digit keydowns and keyups while the candidate guard is active', () => {
      for (const options of [linuxComposing, linuxPostCompositionGuard]) {
        for (const key of [' ', '0', '2', '9']) {
          expect(shouldSuppressTerminalImeKeyboardEvent(event({ key, code: '' }), options)).toBe(
            true
          )
          expect(
            shouldSuppressTerminalImeKeyboardEvent(event({ type: 'keyup', key, code: '' }), options)
          ).toBe(true)
        }
      }
    })

    it('suppresses the follow-on candidate keypress so _keyPress cannot forward the selector', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keypress', key: ' ', code: 'Space' }),
          linuxPostCompositionGuard
        )
      ).toBe(true)
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keypress', key: '2', code: 'Digit2' }),
          linuxComposing
        )
      ).toBe(true)
    })

    it('leaves Space and digits alone once the guard has expired', () => {
      for (const type of ['keydown', 'keyup', 'keypress']) {
        expect(
          shouldSuppressTerminalImeKeyboardEvent(
            event({ type, key: ' ', code: 'Space' }),
            linuxIdle
          )
        ).toBe(false)
        expect(
          shouldSuppressTerminalImeKeyboardEvent(
            event({ type, key: '2', code: 'Digit2' }),
            linuxIdle
          )
        ).toBe(false)
      }
    })

    it('does not treat modified chords such as Ctrl+Space (IME toggle) as candidate keys', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ key: ' ', code: 'Space', ctrlKey: true }),
          linuxPostCompositionGuard
        )
      ).toBe(false)
    })

    it('does not treat Shift+Space (fcitx full-/half-width toggle) as a candidate key', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ key: ' ', code: 'Space', shiftKey: true }),
          linuxPostCompositionGuard
        )
      ).toBe(false)
    })

    it('leaves ordinary letters unsuppressed while the guard is active', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ key: 'a', code: 'KeyA' }),
          linuxPostCompositionGuard
        )
      ).toBe(false)
    })

    it('does not apply the Linux/Sogou candidate guard to Windows', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(event({ key: ' ', code: 'Space' }), windowsComposing)
      ).toBe(false)
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keypress', key: '2', code: 'Digit2' }),
          windowsComposing
        )
      ).toBe(false)
    })

    it('suppresses a pending Linux candidate release even if modifier state changed after keydown', () => {
      expect(
        shouldSuppressTerminalImeKeyboardEvent(
          event({ type: 'keyup', key: '2', code: 'Digit2', shiftKey: true }),
          {
            ...linuxIdle,
            candidateKeyGuardActive: true,
            pendingCandidateKeyReleaseActive: true
          }
        )
      ).toBe(true)
    })
  })

  describe('shouldPreventDefaultTerminalImeCandidateKey', () => {
    it('prevents the default on candidate keydowns while the guard is active', () => {
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(
          event({ key: ' ', code: 'Space' }),
          linuxComposing
        )
      ).toBe(true)
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(
          event({ key: '2', code: 'Digit2' }),
          linuxPostCompositionGuard
        )
      ).toBe(true)
    })

    it('does not prevent the default for keyups, expired guards, or non-candidate keys', () => {
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(
          event({ type: 'keyup', key: ' ', code: 'Space' }),
          linuxComposing
        )
      ).toBe(false)
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(event({ key: ' ', code: 'Space' }), linuxIdle)
      ).toBe(false)
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(
          event({ key: 'a', code: 'KeyA' }),
          linuxComposing
        )
      ).toBe(false)
      expect(
        shouldPreventDefaultTerminalImeCandidateKey(
          event({ key: ' ', code: 'Space' }),
          windowsComposing
        )
      ).toBe(false)
    })
  })
})
