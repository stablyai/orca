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
      // Punctuation, letters, digits, already-substituted CJK glyphs, Hangul
      // jamo and a won sign are all the same case: one printable character.
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
      // Regression: the previous forwarder gated on a 23-term input-source
      // allowlist, so third-party IMEs off that list were never claimed.
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
      // The won-sign key commits a backtick under DefaultKeyBinding.dict; the
      // committed text wins because `key` is never consulted for identity.
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

      // The keypress must be suppressed (it would double-send the ASCII 'a'), and so must the
      // keyup — the forwarder owns the whole claimed lifecycle and emits any owed release itself.
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
        // Time alone must change nothing — no deferral is armed.
        vi.advanceTimersByTime(5000)
        expect(vi.getTimerCount()).toBe(0)

        // The next keydown re-arms, and its own commit is what gets forwarded.
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

    // An app that negotiated kitty `report_event_types` expects a release for every press it
    // received, but xterm's own kitty state is defensively reset while the application tracker
    // stays active — so the forwarder keeps the keyup and encodes the release from the flags it
    // read at commit time rather than delegating either decision to xterm.
    it('keeps the keyup inside the forwarder once the press has reached the pty', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      // Flags default to 0 here: no event types negotiated, so no release is owed.
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('，')
    })

    // The paired case: nothing reached the pty, so a release would describe a press the app
    // never saw. This is the leak the unconditional claim was originally guarding against.
    it('still swallows the keyup when the input source ate the press', () => {
      const { forwarder, sendInput } = install()
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',' }))).toBe(true)
      expect(sendInput).not.toHaveBeenCalled()
    })

    it('keeps the claim armed across a bare modifier keydown before the commit lands', () => {
      // Fast typing: ',' is pressed and released, then Shift goes down for the
      // NEXT character while the text system is still delivering '，'.
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
      // A claimed press whose input never arrived and whose keyup was swallowed
      // elsewhere leaves a tombstone behind.
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

    // A held key emits repeated keydowns. The protocol reports those as REPEAT (event type 2);
    // encoding them all as PRESS would make one held key read as N separate strikes to an app
    // that counts presses or filters repeats.
    // Flags 8|2: the event type only appears on the wire when report_event_types is also
    // negotiated, which is exactly the pane that can tell a repeat from a press.
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
      // The predicate stays structural: the protocol changes what the commit
      // writes, never whether the keystroke is owned.
      const { forwarder } = installWithFlags(() => 8)
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    })

    it('leaves a composing keystroke to the composition path even under bit 3', () => {
      // Scope boundary: a composing IME (Hangul, kana) is never claimed here, so
      // its commit is not this path's to re-encode. Bit 3 fidelity for
      // composition commits would be a change to the composition path.
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
      // The first press delivers and owes a release.
      expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
      dispatchInsertText(textarea, '，')
      // An auto-repeat claim whose text the input source swallows absorbs the
      // eventual keyup; the next fresh press must settle that owed release
      // instead of deleting the record that holds it.
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
      // A TUI that quits on the pressed key pops its negotiation before the
      // keyup; a CSI-u release would land in the successor shell as junk.
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
      // Chromium reports 'Process' for IME-owned keys after a source switch
      // mid-hold; `code` still identifies the physical press.
      expect(
        forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: 'Process', code: 'Comma' }))
      ).toBe(true)
      expect(sendInput.mock.calls.map((call) => call[0])).toEqual(['\x1b[44u', '\x1b[44;1:3u'])
    })

    it('writes the commit raw when the caller tracks no flags at all', () => {
      // The preview bridge installs the forwarder with no pane to negotiate with.
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
