// @vitest-environment happy-dom
/** Panel-only IMEs emit composed insertText after a consumed keydown without a page composition session (#12099, xterm.js#6036). Accept it despite _keyDownSeen, but coordinate deferred textarea diff so synchronous commits never send twice. */
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

  for (const initialState of ['empty', 'refocused', 'committed'] as const) {
    for (const delayed of [false, true]) {
      it(`sends direct punctuation exactly once from ${initialState}, delayed=${delayed}`, async () => {
        const rig = openTerminal()
        try {
          if (initialState === 'committed') {
            dispatchComposition(rig, 'compositionstart', '')
            dispatchComposition(rig, 'compositionupdate', 'ni')
            dispatchComposition(rig, 'compositionend', '你')
            dispatchCommit(rig, '你')
          } else if (initialState === 'refocused') {
            rig.textarea.dispatchEvent(new FocusEvent('blur'))
            rig.textarea.dispatchEvent(new FocusEvent('focus'))
          }
          for (const [code, text] of [
            ['Comma', '，'],
            ['Period', '。'],
            ['Comma', '，']
          ]) {
            dispatchKey(rig, 'keydown', { key: 'Process', code, keyCode: IME_KEYCODE })
            if (delayed) {
              await nextEventLoop()
            }
            dispatchCommit(rig, text)
            dispatchKey(rig, 'keyup', { key: 'Process', code, keyCode: IME_KEYCODE })
            await nextEventLoop()
          }
          await nextEventLoop()
          expect(rig.emitted.join('')).toBe(`${initialState === 'committed' ? '你' : ''}，。，`)
        } finally {
          rig.terminal.dispose()
        }
      })
    }
  }

  // A Process key after compositionend owns new input, not the earlier commit awaiting deferred finalization.
  for (const finalizerFirst of [true, false]) {
    it(`sends punctuation keyed before the commit finalizes, finalizerFirst=${finalizerFirst}`, async () => {
      const rig = openTerminal()
      try {
        dispatchComposition(rig, 'compositionstart', '')
        dispatchComposition(rig, 'compositionupdate', 'ni')
        dispatchComposition(rig, 'compositionend', '你')
        dispatchKey(rig, 'keydown', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
        if (finalizerFirst) {
          await nextEventLoop()
        }
        rig.textarea.value = '你，'
        const input = new InputEvent('input', { bubbles: true })
        Object.defineProperty(input, 'inputType', { value: 'insertText' })
        Object.defineProperty(input, 'data', { value: '，' })
        Object.defineProperty(input, 'composed', { value: true })
        rig.textarea.dispatchEvent(input)
        dispatchKey(rig, 'keyup', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
        await nextEventLoop()
        await nextEventLoop()
        expect(rig.emitted.join('')).toBe('你，')
      } finally {
        rig.terminal.dispose()
      }
    })
  }

  // The keypress sends the key's text on every path, so the input that follows must not claim it.
  for (const finalizerRuns of ['beforeKeypress', 'beforeInput', 'afterInput'] as const) {
    it(`sends a keypress-carried key once after a commit, finalizer ${finalizerRuns}`, async () => {
      const rig = openTerminal()
      try {
        dispatchComposition(rig, 'compositionstart', '')
        dispatchComposition(rig, 'compositionupdate', 'ni')
        dispatchComposition(rig, 'compositionend', '你')
        dispatchKey(rig, 'keydown', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
        if (finalizerRuns === 'beforeKeypress') {
          await nextEventLoop()
        }
        dispatchKey(rig, 'keypress', {
          key: '，',
          code: 'Comma',
          keyCode: 0xff0c,
          charCode: 0xff0c
        })
        if (finalizerRuns === 'beforeInput') {
          await nextEventLoop()
        }
        rig.textarea.value = '你，'
        const input = new InputEvent('input', { bubbles: true })
        Object.defineProperty(input, 'inputType', { value: 'insertText' })
        Object.defineProperty(input, 'data', { value: '，' })
        Object.defineProperty(input, 'composed', { value: true })
        rig.textarea.dispatchEvent(input)
        dispatchKey(rig, 'keyup', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
        await nextEventLoop()
        await nextEventLoop()
        expect(rig.emitted.join('')).toBe('你，')
      } finally {
        rig.terminal.dispose()
      }
    })
  }

  it('sends direct punctuation delivered after the consumed key is released', async () => {
    const rig = openTerminal()
    try {
      dispatchKey(rig, 'keydown', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
      await nextEventLoop()
      dispatchKey(rig, 'keyup', { key: 'Process', code: 'Comma', keyCode: IME_KEYCODE })
      dispatchCommit(rig, '，')
      await nextEventLoop()
      await nextEventLoop()
      expect(rig.emitted.join('')).toBe('，')
    } finally {
      rig.terminal.dispose()
    }
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

  // DBus commit arrives after the textarea diff saw no change, with the candidate number key still held.
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

  // Synchronous commits are also visible to deferred diff; claim one route to avoid sending twice.
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

  // Sogou emits both compositionend and insertText; sessionless fixes must preserve that dedup (xterm.js#3533).
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

  // Clear never-committed claims before the next key; stale claims duplicate macOS caps-lock text forwarded by keypress.
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
