// @vitest-environment happy-dom
/**
 * Pins the two properties that keep #11504 from firing, because neither is a decision anyone
 * made and both are one refactor away from being undone.
 *
 * macOS rewrites a double space into ". " and hands the period to the pty. Orca is not immune to
 * that - a plain Chromium textarea in the Electron version this repo pins does substitute, and
 * `spellcheck="false"` does not prevent it. What prevents it is that the forwarder claims a plain
 * space keydown and then empties the helper textarea, so the text system never sees the preceding
 * word the rule keys on.
 *
 * Both halves are needed. Before 01bcc8dca24 the claim predicate excluded space, letters and
 * digits, the field accumulated, and the substitution fired on real hardware. That commit widened
 * the predicate for unrelated reasons - IME commit survival and kitty encoding - and suppressed
 * this as a side effect it never mentions.
 *
 * So this file does not test the substitution, which cannot be produced in a unit environment. It
 * tests the two conditions measured to suppress it, so narrowing either one fails here rather
 * than in a Korean user's shell.
 */
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

  // Why space specifically: it is the character the substitution rule triggers on, and it is the
  // one the pre-01bcc8dca24 predicate explicitly excluded.
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

  // The second half: a claimed key must leave the field empty, or the text system reads a word
  // before the space and substitutes.
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

  // A control chord is deliberately not claimed - that path belongs to xterm's encoder - so this
  // asserts the exclusions that exist on purpose still hold.
  it('does not claim a control chord', () => {
    const p = pane()
    expect(
      p.forwarder.claimKeyEvent(makeKeydown({ key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true }))
    ).toBe(false)
  })
})
