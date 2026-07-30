// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImeNativeTextForwarder,
  XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT,
  XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT
} from './terminal-ime-native-text-forwarder'

function wonKeydown(): {
  type: 'keydown'
  key: string
  code: string
  metaKey: false
  ctrlKey: false
  altKey: false
  isComposing: false
  keyCode: number
} {
  return {
    type: 'keydown',
    key: '₩',
    code: 'Backquote',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 192
  }
}

function dispatchInsertText(target: HTMLElement, data: '`' | '₩' = '`'): void {
  target.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

describe('xterm composition transaction ownership', () => {
  let element: HTMLDivElement
  let textarea: HTMLTextAreaElement

  beforeEach(() => {
    element = document.createElement('div')
    textarea = document.createElement('textarea')
    element.appendChild(textarea)
    document.body.replaceChildren(element)
  })

  it('leaves every immediate native remap with an accepted composition transaction', () => {
    const sendInput = vi.fn()
    const downstream = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })
    element.addEventListener('input', downstream, true)

    textarea.dispatchEvent(
      new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
    )
    for (const [value, data] of [
      ['한`', '`'],
      ['한`₩', '₩']
    ] as const) {
      expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
      textarea.value = value
      dispatchInsertText(textarea, data)
    }

    expect(sendInput).not.toHaveBeenCalled()
    expect(downstream).not.toHaveBeenCalled()
    expect(textarea.value).toBe('한`₩')

    textarea.dispatchEvent(
      new CustomEvent(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, { bubbles: true })
    )
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    textarea.value = '`'
    dispatchInsertText(textarea)

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('`')
    expect(textarea.value).toBe('')
  })

  it('does not let repeated rejected composition ends steal an immediate remap', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    for (let index = 0; index < 3; index++) {
      textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    }
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    dispatchInsertText(textarea)

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('`')
  })

  it('restarts ownership when another composition transaction is accepted', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    for (let index = 0; index < 2; index++) {
      textarea.dispatchEvent(
        new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
      )
      expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
      dispatchInsertText(textarea)
    }
    textarea.dispatchEvent(
      new CustomEvent(XTERM_COMPOSITION_TRANSACTION_SETTLED_EVENT, { bubbles: true })
    )
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    dispatchInsertText(textarea)

    expect(sendInput).toHaveBeenCalledExactlyOnceWith('`')
  })

  it('drops composition ownership on blur and unmount', () => {
    const sendInput = vi.fn()
    const forwarder = installTerminalImeNativeTextForwarder({
      terminalElement: element,
      isComposing: () => false,
      sendInput
    })

    textarea.dispatchEvent(
      new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
    )
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    textarea.dispatchEvent(new FocusEvent('blur'))
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    dispatchInsertText(textarea)
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('`')

    textarea.dispatchEvent(
      new CustomEvent(XTERM_COMPOSITION_TRANSACTION_ACCEPTED_EVENT, { bubbles: true })
    )
    expect(forwarder.claimKeyEvent(wonKeydown())).toBe(true)
    element.remove()
    forwarder.dispose()
    dispatchInsertText(textarea)

    expect(sendInput).toHaveBeenCalledTimes(1)
  })
})
