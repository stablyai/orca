// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImeNativeTextForwarder,
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
  })
})
