// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImeNativeTextKeyEvent } from './terminal-ime-native-text-candidates'
import {
  installTerminalImeNativeTextForwarder,
  type TerminalImeNativeTextForwarder
} from './terminal-ime-native-text-forwarder'

const KOREAN_FEATURES = {
  forwardHangulJamo: true,
  forwardAsciiPunctuation: true,
  forwardShortTextReplacements: false
} as const

function keyEvent(overrides: Partial<ImeNativeTextKeyEvent>): ImeNativeTextKeyEvent {
  return {
    type: 'keydown',
    key: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    ...overrides
  }
}

describe('native-text claim release across a Hangul composition', () => {
  let element: HTMLDivElement
  let textarea: HTMLTextAreaElement

  beforeEach(() => {
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    element.appendChild(textarea)
    document.body.replaceChildren(element)
  })

  function install(
    isComposing: () => boolean
  ): TerminalImeNativeTextForwarder & { sendInput: ReturnType<typeof vi.fn> } {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing,
      sendInput,
      getInputSourceFeatures: () => KOREAN_FEATURES
    })
    return Object.assign(forwarder, { sendInput })
  }

  // Recorded on macOS 2-Set Korean: "ㅇ" on KeyD, an input-source switch, then
  // "d" on that same physical key. The jamo arrives in `key` before
  // compositionstart, so the keydown looks like a native commit and claims KeyD.
  it('keeps the post-switch keypress on the claimed key out of the forwarder', () => {
    let composing = false
    const forwarder = install(() => composing)

    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keydown', key: 'ㅇ', code: 'KeyD', keyCode: 229 }))
    ).toBe(true)

    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    composing = true
    textarea.value = 'ㅇ'
    textarea.dispatchEvent(
      new InputEvent('input', { data: 'ㅇ', inputType: 'insertCompositionText', bubbles: true })
    )
    forwarder.claimKeyEvent(
      keyEvent({ type: 'keyup', key: 'ㅇ', code: 'KeyD', keyCode: 68, isComposing: true })
    )

    // The input-source switch commits the syllable and closes the composition.
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    composing = false

    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keydown', key: 'd', code: 'KeyD', keyCode: 68 }))
    ).toBe(false)
    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'd', code: 'KeyD', keyCode: 100 }))
    ).toBe(false)
    expect(forwarder.sendInput).not.toHaveBeenCalled()
  })

  it('retires a claim on its keyup even when the release reports isComposing', () => {
    const forwarder = install(() => false)

    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keydown', key: 'ㅇ', code: 'KeyD', keyCode: 229 }))
    ).toBe(true)
    // Bypassing stays off for a composing release so xterm's own IME suppression owns it.
    expect(
      forwarder.claimKeyEvent(
        keyEvent({ type: 'keyup', key: 'ㅇ', code: 'KeyD', keyCode: 68, isComposing: true })
      )
    ).toBe(false)

    expect(
      forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'd', code: 'KeyD', keyCode: 100 }))
    ).toBe(false)
  })

  it('still bypasses the keypress and forwards the glyph for a real native commit', () => {
    const forwarder = install(() => false)

    expect(
      forwarder.claimKeyEvent(
        keyEvent({ type: 'keydown', key: '₩', code: 'Backquote', keyCode: 192 })
      )
    ).toBe(true)
    expect(
      forwarder.claimKeyEvent(
        keyEvent({ type: 'keypress', key: '`', code: 'Backquote', keyCode: 96 })
      )
    ).toBe(true)

    textarea.dispatchEvent(
      new InputEvent('input', { data: '`', inputType: 'insertText', bubbles: true })
    )

    expect(forwarder.sendInput).toHaveBeenCalledExactlyOnceWith('`')
    expect(
      forwarder.claimKeyEvent(
        keyEvent({ type: 'keyup', key: '₩', code: 'Backquote', keyCode: 192 })
      )
    ).toBe(true)
  })
})
