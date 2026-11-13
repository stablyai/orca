// @vitest-environment happy-dom
/** macOS 2-Set right after an input-source switch: plain-commits ㅇ, then rebuilds it as 아 by replacing it (#9738, m4air trace). */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeNativeTextForwarder } from './terminal-ime-native-text-forwarder'

function open() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea!
  const forwarder = installTerminalImeNativeTextForwarder({
    terminalElement: terminal.element,
    isComposing: () => false,
    sendInput: (data) => terminal.input(data),
    getKittyKeyboardFlags: () => 0
  })
  terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))
  const emitted: string[] = []
  terminal.onData((d) => emitted.push(d))
  return { emitted, terminal, textarea, forwarder, container }
}

function keydown(textarea: HTMLTextAreaElement, key: string, code: string, keyCode: number) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true }))
}

function plainCommit(textarea: HTMLTextAreaElement, data: string) {
  textarea.setRangeText(data, textarea.selectionStart, textarea.selectionEnd, 'end')
  textarea.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

// Blink selects the replacement range, fires beforeinput, then writes the text.
function replacingCommit(textarea: HTMLTextAreaElement, start: number, end: number, data: string) {
  textarea.setSelectionRange(start, end)
  textarea.dispatchEvent(
    new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true })
  )
  plainCommit(textarea, data)
}

describe('#9738 plain-committed jamo rebuilt in place', () => {
  let pane: ReturnType<typeof open>

  beforeEach(() => {
    // happy-dom has no canvas, and xterm measures text on open().
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm only calls measureText on this stub.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
    pane = open()
  })

  afterEach(() => {
    pane.forwarder.dispose()
    pane.terminal.dispose()
    pane.container.remove()
    vi.restoreAllMocks()
  })

  it('keeps the jamo for the rebuild and erases it from the PTY when replaced', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')
    expect(pane.textarea.value).toBe('ㅇ')

    keydown(pane.textarea, 'ㅏ', 'KeyK', 75)
    replacingCommit(pane.textarea, 0, 1, '아')

    expect(pane.emitted.join('')).toBe('ㅇ\x7f아')
  })

  it('erases the jamo before a composition that replaces it begins', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

    expect(pane.emitted.join('')).toBe('ㅇ\x7f')
  })

  it('does not erase for an edit whose replacement never reaches the PTY', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertReplacementText', bubbles: true })
    )

    expect(pane.emitted.join('')).toBe('ㅇ')
  })

  it('does not erase once an ordinary composition has begun after the jamo', () => {
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    pane.textarea.setSelectionRange(0, 1)
    pane.textarea.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'insertCompositionText', bubbles: true })
    )

    expect(pane.emitted.join('')).toBe('ㅇ')
  })

  it('removes the jamo from the field on Ctrl+C the pane handles ahead of the forwarder', () => {
    pane.terminal.attachCustomKeyEventHandler(
      (event) => !event.ctrlKey && !pane.forwarder.claimKeyEvent(event)
    )
    keydown(pane.textarea, 'ㅇ', 'KeyD', 68)
    plainCommit(pane.textarea, 'ㅇ')

    pane.textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        ctrlKey: true,
        bubbles: true
      })
    )

    expect(pane.textarea.value).toBe('')
  })
})
