// @vitest-environment happy-dom
/** Claiming plain Space and clearing the textarea prevent macOS double-space period substitution (#11504); spellcheck=false alone does not. Unit tests verify those conditions, since native substitution needs real hardware. */
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
  // Wired the way the pane lifecycle wires it: a claimed key must not also reach xterm's encoder.
  terminal.attachCustomKeyEventHandler((event) => !forwarder.claimKeyEvent(event))
  const emitted: string[] = []
  terminal.onData((d) => emitted.push(d))
  return { emitted, terminal, textarea, forwarder, container }
}

function makeKeydown(init: {
  key: string
  code: string
  keyCode: number
  ctrlKey?: boolean
}): KeyboardEvent {
  return new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
}

function keydown(
  textarea: HTMLTextAreaElement,
  init: { key: string; code: string; keyCode: number }
) {
  const event = makeKeydown(init)
  textarea.dispatchEvent(event)
  return event
}

function commit(textarea: HTMLTextAreaElement, data: string) {
  textarea.value += data
  textarea.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }))
}

describe('#11504 suppression rests on claiming space and emptying the field', () => {
  let panes: ReturnType<typeof open>[] = []

  beforeEach(() => {
    panes = []
    // Why: happy-dom has no canvas, and the renderer measures text on open().
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    for (const pane of panes) {
      pane.forwarder.dispose()
      pane.terminal.dispose()
      pane.container.remove()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  function pane() {
    const created = open()
    panes.push(created)
    return created
  }

  // Space triggers the native substitution rule and must remain claimable.
  it('claims a plain space keydown', () => {
    const p = pane()
    expect(p.forwarder.claimKeyEvent(makeKeydown({ key: ' ', code: 'Space', keyCode: 32 }))).toBe(
      true
    )
  })

  it('claims a plain letter keydown', () => {
    const p = pane()
    expect(p.forwarder.claimKeyEvent(makeKeydown({ key: 'a', code: 'KeyA', keyCode: 65 }))).toBe(
      true
    )
  })

  // Empty the field so the text system cannot read a preceding word and substitute.
  it('leaves the helper textarea empty after a claimed commit, so no word precedes the space', () => {
    const p = pane()
    keydown(p.textarea, { key: 'a', code: 'KeyA', keyCode: 65 })
    commit(p.textarea, 'a')
    keydown(p.textarea, { key: 'b', code: 'KeyB', keyCode: 66 })
    commit(p.textarea, 'b')
    keydown(p.textarea, { key: ' ', code: 'Space', keyCode: 32 })
    commit(p.textarea, ' ')

    expect(p.emitted.join('')).toBe('ab ')
    expect(p.textarea.value).toBe('')
  })

  // Control chords remain with xterm’s encoder.
  it('does not claim a control chord', () => {
    const p = pane()
    expect(
      p.forwarder.claimKeyEvent(makeKeydown({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true }))
    ).toBe(false)
  })
})
