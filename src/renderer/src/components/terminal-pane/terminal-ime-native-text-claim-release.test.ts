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

describe('the claim is retired by releases the bypass rules would otherwise skip', () => {
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

  // Recorded on macOS 2-Set Korean: the jamo arrives in `key` before compositionstart, so
  // the keydown looks like a native commit and claims KeyD. Its release then lands inside
  // the composition it started, and every keyup inside a composition reports isComposing.
  it('retires a claim whose release reports isComposing', () => {
    let composing = false
    const { forwarder, sendInput } = install(() => composing)

    expect(forwarder.claimKeyEvent(keyEvent({ key: 'ㅇ', code: 'KeyD' }))).toBe(true)
    // The composition boundaries are the isComposing flag alone. Dispatching
    // compositionstart/compositionend here would imply a retirement path the forwarder does
    // not have: it listens for input, blur, and the two xterm transaction events, nothing else.
    composing = true

    expect(
      forwarder.claimKeyEvent(
        keyEvent({ type: 'keyup', key: 'ㅇ', code: 'KeyD', isComposing: true })
      )
    ).toBe(false)

    composing = false

    // The keydown for this press was refused while the composition was still live, so
    // nothing is armed to forward it. A stranded claim would bypass it into a dropped key.
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: 'd', code: 'KeyD' }))).toBe(
      false
    )
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('retires a claim whose release arrives under a chord', () => {
    const { forwarder, sendInput } = install()

    expect(forwarder.claimKeyEvent(keyEvent({ key: ',' }))).toBe(true)
    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keyup', key: ',', ctrlKey: true }))).toBe(false)

    expect(forwarder.claimKeyEvent(keyEvent({ type: 'keypress', key: ',' }))).toBe(false)
    expect(sendInput).not.toHaveBeenCalled()
  })
})
