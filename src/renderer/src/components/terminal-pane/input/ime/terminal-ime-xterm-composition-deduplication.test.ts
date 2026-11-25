// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(screenReaderMode = false): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ screenReaderMode })
  terminal.open(container)
  const textarea = terminal.textarea
  if (!textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea }
}

function dispatchCompositionEvent(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function startComposition(textarea: HTMLTextAreaElement, text: string): void {
  dispatchCompositionEvent(textarea, 'compositionstart')
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = text
}

function dispatchKeydown(
  textarea: HTMLTextAreaElement,
  key: string,
  code: string,
  keyCode: number,
  isComposing = false,
  timeStamp?: number
): void {
  const keydown = new KeyboardEvent('keydown', { key, code, isComposing, bubbles: true })
  Object.defineProperty(keydown, 'keyCode', { value: keyCode })
  if (timeStamp !== undefined) {
    Object.defineProperty(keydown, 'timeStamp', { value: timeStamp })
  }
  textarea.dispatchEvent(keydown)
}

function dispatchComposedInput(textarea: HTMLTextAreaElement, init: InputEventInit): void {
  const input = new InputEvent('input', { ...init, bubbles: true })
  // happy-dom ignores InputEventInit.composed, but Chromium reports it for this IBus path.
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function updateObservedIbusComposition(
  textarea: HTMLTextAreaElement,
  prefix: string,
  text: string
): void {
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertCompositionText' })
}

function startObservedIbusComposition(textarea: HTMLTextAreaElement, text: string): string {
  const prefix = textarea.value
  textarea.setSelectionRange(prefix.length, prefix.length)
  dispatchCompositionEvent(textarea, 'compositionstart')
  dispatchKeydown(textarea, 'Process', 'KeyG', 229)
  updateObservedIbusComposition(textarea, prefix, text)
  return prefix
}

function endObservedIbusComposition(textarea: HTMLTextAreaElement, prefix: string): void {
  dispatchCompositionEvent(textarea, 'compositionupdate')
  textarea.value = prefix
  dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
  dispatchCompositionEvent(textarea, 'compositionend')
}

function commitObservedIbusComposition(
  textarea: HTMLTextAreaElement,
  prefix: string,
  text: string
): void {
  endObservedIbusComposition(textarea, prefix)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertText' })
}

function typeObservedIbusKeypressCommit(textarea: HTMLTextAreaElement, text: string): void {
  const prefix = startObservedIbusComposition(textarea, text)
  endObservedIbusComposition(textarea, prefix)
  dispatchKeypress(textarea, text)
  textarea.value = `${prefix}${text}`
  dispatchComposedInput(textarea, { data: text, inputType: 'insertText' })
}

function dispatchKeypress(textarea: HTMLTextAreaElement, text: string): void {
  const keypress = new KeyboardEvent('keypress', { key: text, bubbles: true })
  // happy-dom omits Chromium's legacy charCode field that xterm still reads.
  Object.defineProperty(keypress, 'charCode', { value: text.charCodeAt(0) })
  textarea.dispatchEvent(keypress)
}

function getPendingFinalizationCount(terminal: Terminal): number {
  const pending = (
    terminal as unknown as {
      _core: { _compositionHelper: { _pendingComposition?: unknown } }
    }
  )._core._compositionHelper._pendingComposition
  return pending === undefined ? 0 : 1
}

describe('xterm IME composition de-duplication', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('preserves a macOS Hangul candidate when the input source changes to ASCII', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionupdate', 'a')
    textarea.value = '한a'
    dispatchComposedInput(textarea, { data: 'a', inputType: 'insertText' })
    dispatchCompositionEvent(textarea, 'compositionend', 'a')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('uses the selected Chinese candidate instead of its Pinyin preedit', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 'ni')
    textarea.value = 'ni'
    dispatchCompositionEvent(textarea, 'compositionend', '你')
    textarea.value = '你'
    dispatchComposedInput(textarea, { data: '你', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('你')
    terminal.dispose()
  })

  it('does not let stale timers leak across composition transactions', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '테')
    dispatchCompositionEvent(textarea, 'compositionend', '테')
    dispatchKeydown(textarea, 'a', 'KeyA', 65)
    dispatchKeydown(textarea, 'Process', 'KeyR', 229)
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    updateObservedIbusComposition(textarea, '테', '스')
    commitObservedIbusComposition(textarea, '테', '스')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('테a스\r')
    terminal.dispose()
  })

  it('keeps screen-reader trailing text outside an authoritative commit', async () => {
    const { emitted, terminal, textarea } = openTerminal(true)

    textarea.value = '一二'
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '一')
    textarea.value = '一一二'
    textarea.setSelectionRange(2, 2)
    dispatchCompositionEvent(textarea, 'compositionend', '一')
    dispatchComposedInput(textarea, { data: '一', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('一')
    terminal.dispose()
  })

  it('deduplicates each commit without suppressing a legitimate repeated syllable', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusKeypressCommit(textarea, '가')
    typeObservedIbusKeypressCommit(textarea, '가')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('가가\r')
    terminal.dispose()
  })

  it('keeps matching text when a new composition restarts immediately', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '日本')
    await nextEventLoop()
    dispatchCompositionEvent(textarea, 'compositionend', '日本')

    textarea.setSelectionRange(2, 2)
    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '本')
    textarea.value = '日本本'
    textarea.setSelectionRange(3, 3)
    dispatchCompositionEvent(textarea, 'compositionend', '本')
    await nextEventLoop()

    expect(emitted.join('')).toBe('日本本')
    terminal.dispose()
  })

  it('does not emit deferred composition data after disposal', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')

    terminal.dispose()
    await nextEventLoop()

    expect(emitted).toEqual([])
    expect(getPendingFinalizationCount(terminal)).toBe(0)
  })

  it('preserves multiple keypresses when textarea propagation is partial', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, 'a')
    dispatchKeypress(textarea, 'b')
    textarea.value = '한a'
    await nextEventLoop()

    expect(emitted.join('')).toBe('한ab')
    terminal.dispose()
  })

  it('finalizes source-switch cancellation before a later Korean composition', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchKeydown(textarea, 'Escape', 'Escape', 229, true, 100)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    dispatchKeydown(textarea, 'Escape', 'Escape', 27, false, 100)
    await nextEventLoop()
    expect(emitted).toEqual([])

    textarea.value = ''
    startComposition(textarea, '한')
    await nextEventLoop()
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  // vim: commit a word, then leave insert mode at once; the accepted commit must precede the ESC.
  it('sends an accepted commit before a plain Escape that lands before finalization', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '日本語')
    await nextEventLoop()

    textarea.dispatchEvent(
      new CompositionEvent('compositionend', { data: '日本語', bubbles: true })
    )
    dispatchKeydown(textarea, 'Escape', 'Escape', 27)
    await nextEventLoop()

    expect(emitted).toEqual(['日本語', '\x1b'])
    terminal.dispose()
  })
})
