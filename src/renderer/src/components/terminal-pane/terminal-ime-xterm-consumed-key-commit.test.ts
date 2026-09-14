// @vitest-environment happy-dom
/**
 * An IME that shows candidates only in its own panel — ibus+Rime, fcitx5 with application preedit
 * disabled — opens no composition session in the page, so a candidate picked with a number key
 * arrives as a bare `insertText` with no compositionstart/update/end around it (#12099, and
 * upstream xtermjs/xterm.js#6036).
 *
 * xterm forwards nothing for the keydown the IME consumed, yet `_keyDownSeen` still records it as a
 * key being held, and `_inputEvent` admits a `composed` insertText only when no key is down — so
 * the commit is dropped. The reporter's three cases differ only in that flag: mouse selection has
 * no key down, a multi-character word runs through a real composition session, and a single
 * character picked by number key is discarded.
 *
 * The commit for such a keydown is owed by exactly one of two paths — CompositionHelper's deferred
 * textarea diff, or the input event itself — and which one observes it first depends on whether the
 * IME commits synchronously. Both orderings are pinned here, because a fix that only unblocks the
 * input event re-sends everything the diff already delivered.
 */
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const IME_KEYCODE = 229

type Rig = {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea }
}

function dispatchKey(
  { textarea }: Rig,
  type: 'keydown' | 'keyup' | 'keypress',
  init: { key: string; code: string; keyCode: number; charCode?: number }
): void {
  const event = new KeyboardEvent(type, {
    key: init.key,
    code: init.code,
    bubbles: true,
    cancelable: true
  })
  // happy-dom drops the legacy numeric fields from KeyboardEventInit; xterm's IME paths read them.
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  Object.defineProperty(event, 'charCode', { value: init.charCode ?? 0 })
  textarea.dispatchEvent(event)
}

/** The commit itself: the browser has already written it into the textarea when `input` fires. */
function dispatchCommit({ textarea }: Rig, data: string): void {
  textarea.value = data
  const event = new InputEvent('input', { bubbles: true })
  Object.defineProperty(event, 'inputType', { value: 'insertText' })
  Object.defineProperty(event, 'data', { value: data })
  // Trusted user events are always composed; that is what makes the guard collapse to "no key down".
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

function dispatchComposition(
  { textarea }: Rig,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string
): void {
  if (type !== 'compositionstart') {
    textarea.value = data
  }
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

/** Typing pinyin under a panel-only IME: every letter is consumed, nothing reaches the page. */
async function typeConsumedPinyin(rig: Rig, codes: string[]): Promise<void> {
  for (const code of codes) {
    dispatchKey(rig, 'keydown', { key: 'Process', code, keyCode: IME_KEYCODE })
    await nextEventLoop()
    dispatchKey(rig, 'keyup', { key: 'Process', code, keyCode: IME_KEYCODE })
    await nextEventLoop()
  }
}

describe('a candidate commit that arrives with no composition session', () => {
  beforeEach(() => {
    // happy-dom has no 2d context, which the DOM renderer's WidthCache requires.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends a candidate picked with the mouse, with no key down', async () => {
    const rig = openTerminal()
    await typeConsumedPinyin(rig, ['KeyH', 'KeyA', 'KeyO'])
    dispatchCommit(rig, '好')
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('好')
  })

  it('sends a candidate committed by a real composition session exactly once', async () => {
    const rig = openTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchComposition(rig, 'compositionupdate', 'hao')
    await nextEventLoop()
    dispatchKey(rig, 'keydown', { key: 'Process', code: 'Digit1', keyCode: IME_KEYCODE })
    dispatchComposition(rig, 'compositionend', '好的')
    await nextEventLoop()
    dispatchKey(rig, 'keyup', { key: '1', code: 'Digit1', keyCode: 49 })
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('好的')
  })

  // The reporter's failing case. ibus answers over DBus, so the commit lands after the deferred
  // textarea diff has already run against an unchanged textarea — and the number key is still down.
  it('sends a commit that arrives after the deferred diff while the consumed key is down', async () => {
    const rig = openTerminal()
    await typeConsumedPinyin(rig, ['KeyH', 'KeyA', 'KeyO'])
    dispatchKey(rig, 'keydown', { key: 'Process', code: 'Digit1', keyCode: IME_KEYCODE })
    await nextEventLoop()
    dispatchCommit(rig, '好')
    await nextEventLoop()
    dispatchKey(rig, 'keyup', { key: '1', code: 'Digit1', keyCode: 49 })
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('好')
  })

  // The same gesture from an IME that commits synchronously. Here the deferred diff would also see
  // the character, so admitting the input event without cancelling the diff sends 好好.
  it('sends a commit that arrives before the deferred diff exactly once', async () => {
    const rig = openTerminal()
    await typeConsumedPinyin(rig, ['KeyH', 'KeyA', 'KeyO'])
    dispatchKey(rig, 'keydown', { key: 'Process', code: 'Digit1', keyCode: IME_KEYCODE })
    dispatchCommit(rig, '好')
    await nextEventLoop()
    dispatchKey(rig, 'keyup', { key: '1', code: 'Digit1', keyCode: 49 })
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('好')
  })

  // Regression guard for xtermjs/xterm.js#3533: Sogou on Linux fires compositionend *and*
  // insertText for one commit, and the `!ev.composed` half of the guard exists to stop that
  // doubling. Claiming a sessionless commit must not reopen it.
  it('sends one commit when the IME fires both compositionend and insertText', async () => {
    const rig = openTerminal()
    dispatchComposition(rig, 'compositionstart', '')
    dispatchComposition(rig, 'compositionupdate', 'hao')
    await nextEventLoop()
    dispatchComposition(rig, 'compositionend', '好')
    dispatchCommit(rig, '好')
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('好')
  })

  // An IME-consumed keydown that never commits must not leave the claim armed for the next key.
  // Upper-case letters take xterm's macOS caps-lock path, which forwards from keypress and then
  // lets the input event through, so a stale claim would send the letter twice.
  it('does not double an upper-case letter typed after a consumed keydown that never committed', async () => {
    const rig = openTerminal()
    await typeConsumedPinyin(rig, ['KeyH'])
    dispatchKey(rig, 'keydown', { key: 'A', code: 'KeyA', keyCode: 65 })
    dispatchKey(rig, 'keypress', { key: 'A', code: 'KeyA', keyCode: 65, charCode: 65 })
    dispatchCommit(rig, 'A')
    await nextEventLoop()
    dispatchKey(rig, 'keyup', { key: 'A', code: 'KeyA', keyCode: 65 })
    await nextEventLoop()
    await nextEventLoop()
    expect(rig.emitted.join('')).toBe('A')
  })
})
