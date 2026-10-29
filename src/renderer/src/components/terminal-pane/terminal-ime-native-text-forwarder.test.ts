// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImeNativeTextForwarder,
  XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
  XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT,
  type ImeNativeTextKeyEvent
} from './terminal-ime-native-text-forwarder'

function keyEvent(overrides: Partial<ImeNativeTextKeyEvent>): ImeNativeTextKeyEvent {
  return {
    type: 'keydown',
    key: ',',
    code: 'Comma',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  }
}

function dispatchInsertText(target: HTMLElement, data: string | null): void {
  target.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

describe('installTerminalImeNativeTextForwarder', () => {
  let element: HTMLDivElement
  let textarea: HTMLTextAreaElement

  beforeEach(() => {
    document.body.replaceChildren()
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    textarea.className = 'xterm-helper-textarea'
    element.appendChild(textarea)
    document.body.appendChild(element)
  })

  function install(isComposing: () => boolean = () => false): {
    forwarder: ReturnType<typeof installTerminalImeNativeTextForwarder>
    sendInput: ReturnType<typeof vi.fn>
  } {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing,
      sendInput
    })
    return { forwarder, sendInput }
  }

  describe('the claim is structural', () => {
    it('claims every single printable key regardless of which character it is', () => {
      const { forwarder } = install()
      // Treat all single printable characters equally, including punctuation, jamo and substituted CJK.
      for (const key of [
        ',',
        '.',
        '?',
        '\\',
        '!',
        'a',
        'Z',
        '9',
        '，',
        '。',
        '、',
        'ᄒ',
        '₩',
        '１'
      ]) {
        expect(forwarder.claimKeyEvent(keyEvent({ key }))).toBe(true)
      }
    })

    it('claims without reading any input source, so unknown IMEs work too', () => {
      // Source allowlists missed third-party IMEs; claims must stay structural.
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: '\\', code: 'Backslash' }))).toBe(true)
      dispatchInsertText(textarea, '、')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('、')
    })

    it('rejects Ctrl/Alt/Meta chords but accepts shifted punctuation', () => {
      const { forwarder } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'v', metaKey: true }))).toBe(false)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', altKey: true }))).toBe(false)
      expect(forwarder.claimKeyEvent(keyEvent({ key: '!', code: 'Digit1' }))).toBe(true)
    })

    it('rejects named keys and multi-code-unit keys on length alone', () => {
      const { forwarder } = install()
      // No enumeration needed: none of these is one code unit long.
      for (const key of [
        'Enter',
        'Tab',
        'ArrowLeft',
        'Escape',
        'Dead',
        'F3',
        'Unidentified',
        '😀'
      ]) {
        expect(forwarder.claimKeyEvent(keyEvent({ key }))).toBe(false)
      }
    })

    it('rejects keystrokes that belong to an active composition', () => {
      const { forwarder } = install(() => true)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
      const { forwarder: other } = install()
      expect(other.claimKeyEvent(keyEvent({ key: ',', isComposing: true }))).toBe(false)
    })

    it('rejects non-keydown types when it did not claim the keydown', () => {
      const { forwarder, sendInput } = install(() => true)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(false)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(false)
      dispatchInsertText(textarea, '，')
      expect(sendInput).not.toHaveBeenCalled()
    })
  })

  describe('forwarding the committed text', () => {
    it('forwards the IME-committed full-width glyph from the input event', () => {
      const { forwarder, sendInput } = install()
      const laterInputListener = vi.fn()
      element.addEventListener('input', laterInputListener, true)

      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      textarea.value = '，'
      dispatchInsertText(textarea, '，')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
      expect(laterInputListener).not.toHaveBeenCalled()
      expect(textarea.value).toBe('')
    })

    it('forwards a multi-code-unit commit from a single press', () => {
      // `——` is two code units; reading `ev.data` wholesale covers it for free.
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: '_', code: 'Minus' }))).toBe(true)
      dispatchInsertText(textarea, '——')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('——')
    })

    it('forwards the committed text when the keydown already carries the glyph', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: '。', code: 'Period' }))).toBe(true)
      dispatchInsertText(textarea, '。')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('。')
    })

    it('forwards what the key binding substituted, not what the key said', () => {
      // DefaultKeyBinding.dict commits backtick from the won-sign key; committed text owns character identity.
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: '₩', code: 'Backquote' }))).toBe(true)
      dispatchInsertText(textarea, '`')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('`')
    })

    it('forwards a plain ASCII symbol unchanged when the IME does not convert it', () => {
      const { forwarder, sendInput } = install()
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      dispatchInsertText(textarea, ',')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith(',')
    })

    it('forwards Vietnamese letter replacement text and suppresses matching key events', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'á', code: 'KeyA' }))).toBe(
        true
      )
      dispatchInsertText(textarea, 'á')

      // The forwarder owns keypress and keyup too; xterm must neither double-send text nor emit a second release.
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'a', code: 'KeyA' }))).toBe(
        true
      )
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('á')
    })

    it('does not forward input when no keydown was claimed', () => {
      const { sendInput } = install()
      dispatchInsertText(textarea, '😀')
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('only forwards a single input per claimed keydown', () => {
      const { forwarder, sendInput } = install()
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      dispatchInsertText(textarea, '，')
      dispatchInsertText(textarea, '。')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    it('ignores composition input events even after a claimed keydown', () => {
      const { forwarder, sendInput } = install()
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      textarea.dispatchEvent(
        new InputEvent('input', { data: '，', inputType: 'insertCompositionText', bubbles: true })
      )
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('clears pending forwarding when a composition input takes over', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      textarea.dispatchEvent(
        new InputEvent('input', { data: 'に', inputType: 'insertCompositionText', bubbles: true })
      )
      dispatchInsertText(textarea, '日本語')

      expect(sendInput).not.toHaveBeenCalled()
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
    })
  })

  describe('claim lifetime is bounded by events, never by a timer', () => {
    it('keeps the claim armed across keyup until the committed input arrives', () => {
      // Some macOS IMEs deliver keyup before the final insertText.
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    it('drops a stale claim on the next keydown rather than on elapsed time', () => {
      vi.useFakeTimers()
      try {
        const { forwarder, sendInput } = install()
        // First press is swallowed by the IME: no input event ever arrives.
        expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
        expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
        vi.advanceTimersByTime(5000)
        expect(vi.getTimerCount()).toBe(0)

        expect(forwarder.claimKeyEvent(keyEvent({ key: '.', code: 'Period' }))).toBe(true)
        dispatchInsertText(textarea, '。')
        expect(sendInput).toHaveBeenCalledExactlyOnceWith('。')
      } finally {
        vi.useRealTimers()
      }
    })

    it('bypasses keypress without clearing the armed forward (avoids ASCII double-send)', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    it('bypasses transformed keypresses even when the browser omits physical code', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
      expect(
        forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'á', code: undefined }))
      ).toBe(true)
      dispatchInsertText(textarea, 'á')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('á')
    })

    // Application flags can outlive xterm’s defensive reset; encode the owed release using commit-time negotiation.
    it('keeps the keyup inside the forwarder once the press has reached the pty', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    // Undelivered presses owe no release; unconditional forwarding would leak an orphan keyup.
    it('still swallows the keyup when the input source ate the press', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('keeps the claim armed across a bare modifier keydown before the commit lands', () => {
      // Shift for the next character may precede the previous text commit; it must not retire that claim.
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      expect(
        forwarder.claimKeyEvent(keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))
      ).toBe(false)
      dispatchInsertText(textarea, '，')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    it('lets a chorded keyup reach xterm after a fresh chorded press of the same key', () => {
      const { forwarder, sendInput } = install()
      // An IME-swallowed press and missed keyup leave a tombstone.
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'n', code: 'KeyN' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'x', code: 'KeyX' }))).toBe(true)
      // Ctrl+N is xterm's press; its keyup must not be eaten by the stale tombstone.
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'n', code: 'KeyN', ctrlKey: true }))).toBe(
        false
      )
      expect(
        forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'n', code: 'KeyN', ctrlKey: true }))
      ).toBe(false)
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('releases the claim on blur', () => {
      const { forwarder, sendInput } = install()
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
      dispatchInsertText(textarea, '，')
      expect(sendInput).not.toHaveBeenCalled()
    })
  })

  describe('composition transactions keep ownership', () => {
    it('lets an accepted transaction own its own commit', () => {
      const { forwarder, sendInput } = install()
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      element.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
      )
      dispatchInsertText(textarea, '，')
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('resumes forwarding once the transaction settles', () => {
      const { forwarder, sendInput } = install()
      element.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
      )
      element.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, { bubbles: true })
      )
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      dispatchInsertText(textarea, '，')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })
  })

  describe('the kitty read is scoped to the commit', () => {
    function installWithFlags(
      getKittyKeyboardFlags: () => number,
      isComposing: () => boolean = () => false
    ): {
      forwarder: ReturnType<typeof installTerminalImeNativeTextForwarder>
      sendInput: ReturnType<typeof vi.fn>
    } {
      const sendInput = vi.fn()
      const forwarder = installTerminalImeNativeTextForwarder({
        terminalElement: element,
        isComposing,
        sendInput,
        getKittyKeyboardFlags
      })
      return { forwarder, sendInput }
    }

    it('never reads the flags on a keydown, only on the commit', () => {
      const getKittyKeyboardFlags = vi.fn(() => 8)
      const { forwarder } = installWithFlags(getKittyKeyboardFlags)

      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      forwarder.claimKeyEvent(keyEvent({ key: ',', type: 'keypress' }))
      expect(getKittyKeyboardFlags).not.toHaveBeenCalled()

      dispatchInsertText(textarea, '，')
      expect(getKittyKeyboardFlags).toHaveBeenCalledOnce()
    })

    // Held repeats must encode REPEAT, not separate presses; flags 8|2 make that distinction observable.
    it('encodes an auto-repeat commit as REPEAT, not as another PRESS', () => {
      const { forwarder, sendInput } = installWithFlags(() => 0b1010)

      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)
      dispatchInsertText(textarea, 'a')
      const firstPress = sendInput.mock.calls[0][0]

      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA', repeat: true }))).toBe(true)
      dispatchInsertText(textarea, 'a')
      const repeated = sendInput.mock.calls[1][0]

      expect(firstPress).toBe('[97u')
      expect(repeated).toBe('[97;1:2u')
    })

    it('claims the keydown under bit 3 exactly as it does without it', () => {
      // Protocol flags change commit encoding, never structural keystroke ownership.
      const { forwarder } = installWithFlags(() => 8)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    })

    it('reports the authoritative multi-codepoint committed text', () => {
      const { forwarder, sendInput } = installWithFlags(() => 24)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyA' }))).toBe(true)

      dispatchInsertText(textarea, 'á')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[97;;97:769u')
    })

    it('falls back to the native key identity before a non-US layout resolves', () => {
      const { forwarder, sendInput } = installWithFlags(() => 8)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'a', code: 'KeyQ' }))).toBe(true)

      dispatchInsertText(textarea, 'a')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[97u')
    })

    it('derives shifted non-US identity while the layout is unresolved', () => {
      const { forwarder, sendInput } = installWithFlags(() => 12)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'A', code: 'KeyQ', shiftKey: true }))).toBe(
        true
      )

      dispatchInsertText(textarea, 'A')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[97:65:113;2u')
    })

    it('keeps CapsLock casing out of the unmodified key identity', () => {
      const { forwarder, sendInput } = installWithFlags(() => 8)
      expect(
        forwarder.claimKeyEvent(
          keyEvent({
            key: 'A',
            code: 'KeyQ',
            getModifierState: (modifier) => modifier === 'CapsLock'
          })
        )
      ).toBe(true)

      dispatchInsertText(textarea, 'A')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[97;65u')
    })

    it('falls back to the native key identity for an unresolved ISO key', () => {
      const { forwarder, sendInput } = installWithFlags(() => 8)
      expect(forwarder.claimKeyEvent(keyEvent({ key: '<', code: 'IntlBackslash' }))).toBe(true)

      dispatchInsertText(textarea, '<')

      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[60u')
    })

    it('preserves Kitty numpad identities for press and release', () => {
      const { forwarder, sendInput } = installWithFlags(() => 2)
      expect(forwarder.claimKeyEvent(keyEvent({ key: '1', code: 'Numpad1' }))).toBe(true)
      dispatchInsertText(textarea, '1')
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: '1', code: 'Numpad1' }))).toBe(
        true
      )

      expect(sendInput.mock.calls.map((call) => call[0])).toEqual([
        '\x1b[57400u',
        '\x1b[57400;1:3u'
      ])
    })

    it('preserves NumpadSeparator functional identity for press and release', () => {
      const { forwarder, sendInput } = installWithFlags(() => 2)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',', code: 'NumpadSeparator' }))).toBe(true)
      dispatchInsertText(textarea, ',')
      expect(
        forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',', code: 'NumpadSeparator' }))
      ).toBe(true)

      expect(sendInput.mock.calls.map((call) => call[0])).toEqual([
        '\x1b[57416u',
        '\x1b[57416;1:3u'
      ])
    })

    it.each([
      [',', 'NumpadComma', 44],
      ['(', 'NumpadParenLeft', 40]
    ])('keeps printable %s (%s) raw while reporting its release', (key, code, codePoint) => {
      const { forwarder, sendInput } = installWithFlags(() => 2)
      expect(forwarder.claimKeyEvent(keyEvent({ key, code }))).toBe(true)
      dispatchInsertText(textarea, key)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key, code }))).toBe(true)

      expect(sendInput.mock.calls.map((call) => call[0])).toEqual([key, `\x1b[${codePoint};1:3u`])
    })

    it('pins a keypad release to the NumLock-on press identity', () => {
      const { forwarder, sendInput } = installWithFlags(() => 2)
      expect(
        forwarder.claimKeyEvent(
          keyEvent({
            key: '4',
            code: 'Numpad4',
            getModifierState: (modifier) => modifier === 'NumLock'
          })
        )
      ).toBe(true)
      dispatchInsertText(textarea, '4')
      expect(
        forwarder.claimKeyEvent(
          keyEvent({
            type: 'keyup',
            key: 'ArrowLeft',
            code: 'Numpad4',
            getModifierState: () => false
          })
        )
      ).toBe(true)

      expect(sendInput.mock.calls.map((call) => call[0])).toEqual([
        '\x1b[57403;129u',
        '\x1b[57403;1:3u'
      ])
    })

    it('pins an unresolved shifted key to the committed press identity', () => {
      const { forwarder, sendInput } = installWithFlags(() => 2)
      expect(
        forwarder.claimKeyEvent(keyEvent({ key: '>', code: 'IntlBackslash', shiftKey: true }))
      ).toBe(true)
      dispatchInsertText(textarea, '>')
      expect(
        forwarder.claimKeyEvent(
          keyEvent({ type: 'keyup', key: '<', code: 'IntlBackslash', shiftKey: false })
        )
      ).toBe(true)

      expect(sendInput.mock.calls.map((call) => call[0])).toEqual(['>', '\x1b[62;1:3u'])
    })

    it('leaves a composing keystroke to the composition path even under bit 3', () => {
      // Composing Hangul/kana stays outside this forwarder; composition CSI-u fidelity belongs to its own path.
      const { forwarder, sendInput } = installWithFlags(
        () => 8,
        () => true
      )
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'r' }))).toBe(false)
      dispatchInsertText(textarea, '한')
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('emits the owed release before a same-key re-claim when the input event never came', () => {
      const { forwarder, sendInput } = installWithFlags(() => 0b1010)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      // A swallowed repeat cannot erase the earlier delivered press’s release obligation; settle it on the next fresh press.
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',', repeat: true }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(sendInput.mock.calls.map((call) => call[0])).toEqual(['\x1b[44u', '\x1b[44;1:3u'])
    })

    it('settles an owed release before a fresh same-key press after a lost keyup', () => {
      const { forwarder, sendInput } = installWithFlags(() => 0b1010)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',', code: 'Comma' }))).toBe(true)
      dispatchInsertText(textarea, '，')

      expect(forwarder.claimKeyEvent(keyEvent({ key: ',', code: 'Comma' }))).toBe(true)
      expect(sendInput.mock.calls.map((call) => call[0])).toEqual(['\x1b[44u', '\x1b[44;1:3u'])
    })

    it('suppresses the owed release when the app popped kitty mode before the keyup', () => {
      // Popping negotiation before keyup must not leak CSI-u release into the successor shell.
      let flags = 0b1010
      const { forwarder, sendInput } = installWithFlags(() => flags)
      expect(forwarder.claimKeyEvent(keyEvent({ key: 'q', code: 'KeyQ' }))).toBe(true)
      dispatchInsertText(textarea, 'q')
      flags = 0
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'q', code: 'KeyQ' }))).toBe(
        true
      )
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('\x1b[113u')
    })

    it('encodes the release from the press when an input source rewrote the keyup key', () => {
      const { forwarder, sendInput } = installWithFlags(() => 0b1010)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      // Source switches can rewrite keyup to Process while code still identifies the physical press.
      expect(
        forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'Process', code: 'Comma' }))
      ).toBe(true)
      expect(sendInput.mock.calls.map((call) => call[0])).toEqual(['\x1b[44u', '\x1b[44;1:3u'])
    })

    it('writes the commit raw when the caller tracks no flags at all', () => {
      const sendInput = vi.fn()
      const forwarder = installTerminalImeNativeTextForwarder({
        terminalElement: element,
        isComposing: () => false,
        sendInput
      })
      forwarder.claimKeyEvent(keyEvent({ key: ',' }))
      dispatchInsertText(textarea, '，')
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })
  })

  it('stops forwarding after dispose', () => {
    const { forwarder, sendInput } = install()
    forwarder.claimKeyEvent(keyEvent({ key: ',' }))
    forwarder.dispose()
    dispatchInsertText(textarea, '，')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('is a no-op when no terminal element is provided', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: null,
      isComposing: () => false,
      sendInput
    })

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(false)
    expect(() => forwarder.dispose()).not.toThrow()
  })
})
