import { describe, expect, it } from 'vitest'
import {
  shouldBypassXtermKeyboardEvent,
  shouldPreventDefaultTerminalImeCandidateKey,
  shouldSuppressTerminalImeKeyboardEvent
} from './xterm-bypass-policy'
import { event } from './xterm-bypass-event-fixture'

describe('shouldBypassXtermKeyboardEvent — macOS', () => {
  const opts = { isMac: true, hasSelection: true }
  const noSel = { isMac: true, hasSelection: false }

  it.each([1, 2, 3, 8, 31])('lets unselected Cmd+C reach Kitty flags %i', (flags) => {
    for (const type of ['keydown', 'keyup']) {
      for (const repeat of [false, true]) {
        const chord = event({ type, key: 'c', code: 'KeyC', metaKey: true, repeat })
        expect(shouldBypassXtermKeyboardEvent(chord, { ...noSel, kittyKeyboardFlags: flags })).toBe(
          false
        )
        expect(shouldBypassXtermKeyboardEvent(chord, { ...opts, kittyKeyboardFlags: flags })).toBe(
          true
        )
        expect(
          shouldBypassXtermKeyboardEvent(
            { ...chord, defaultPrevented: true },
            { ...noSel, kittyKeyboardFlags: flags }
          )
        ).toBe(true)
      }
    }
  })

  it('matches Cmd+C by produced logical key rather than physical key', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'c', code: 'KeyJ', metaKey: true }), opts)
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: 'j', code: 'KeyC', metaKey: true }), opts)
    ).toBe(false)
  })

  it('bubbles already-handled Cmd app shortcuts so kitty does not also write to shell', () => {
    // An app shortcut may preventDefault without stopping propagation; never send it to the PTY too.
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

  it('does not bubble already-handled Ctrl chords on macOS', () => {
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ key: 'c', code: 'KeyC', defaultPrevented: true, ctrlKey: true }),
        opts
      )
    ).toBe(false)
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

  it('leaves ordinary Shift+Space available to the terminal', () => {
    expect(
      shouldBypassXtermKeyboardEvent(event({ key: ' ', code: 'Space', shiftKey: true }), opts)
    ).toBe(false)
  })
})

describe('shouldSuppressTerminalImeKeyboardEvent — macOS', () => {
  const idle = {
    isMac: true,
    isLinux: false,
    compositionActive: false,
    candidateKeyGuardActive: false,
    pendingCandidateKeyReleaseActive: false
  }
  const composing = {
    isMac: true,
    isLinux: false,
    compositionActive: true,
    candidateKeyGuardActive: true,
    pendingCandidateKeyReleaseActive: false
  }

  it('suppresses keyboard events while Chromium reports active IME composition', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Backspace', code: 'Backspace', isComposing: true }),
        idle
      )
    ).toBe(true)
  })

  it('lets standalone Process keys reach xterm so its CompositionHelper can diff text', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        idle
      )
    ).toBe(false)
  })

  it('lets an idle Linux Process keydown reach xterm when Chromium marks it composing', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'Comma', keyCode: 229, isComposing: true }),
        { ...idle, isMac: false, isLinux: true }
      )
    ).toBe(false)
  })

  it('suppresses standalone Process keyups so kitty release reporting cannot leak', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ type: 'keyup', key: 'Process', code: 'KeyN', keyCode: 229 }),
        idle
      )
    ).toBe(true)
  })

  it('suppresses Process keys while the terminal composition tracker is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Process', code: 'KeyN', keyCode: 229 }),
        composing
      )
    ).toBe(true)
  })

  it('suppresses IME-owned editing keys while composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'Backspace', code: 'Backspace' }),
        composing
      )
    ).toBe(true)
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ key: 'ArrowDown', code: 'ArrowDown' }),
        composing
      )
    ).toBe(true)
  })

  it('does not suppress ordinary text keys solely because composition is active', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: 'a', code: 'KeyA' }), composing)
    ).toBe(false)
  })

  it('does not suppress keypress events because they carry committed text', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ type: 'keypress', key: '中', code: '', isComposing: true }),
        idle
      )
    ).toBe(false)
  })

  it('does not apply the Linux/Sogou candidate guard to macOS', () => {
    expect(
      shouldSuppressTerminalImeKeyboardEvent(event({ key: ' ', code: 'Space' }), composing)
    ).toBe(false)
    expect(
      shouldSuppressTerminalImeKeyboardEvent(
        event({ type: 'keypress', key: '2', code: 'Digit2' }),
        composing
      )
    ).toBe(false)
    expect(
      shouldPreventDefaultTerminalImeCandidateKey(event({ key: ' ', code: 'Space' }), composing)
    ).toBe(false)
  })
})
