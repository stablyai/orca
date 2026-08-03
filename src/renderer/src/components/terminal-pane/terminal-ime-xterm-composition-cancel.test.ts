// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
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

function dispatchProcessKeydown(textarea: HTMLTextAreaElement): void {
  const keydown = new KeyboardEvent('keydown', {
    key: 'Process',
    code: 'KeyC',
    isComposing: true,
    bubbles: true
  })
  Object.defineProperty(keydown, 'keyCode', { value: 229 })
  textarea.dispatchEvent(keydown)
}

function dispatchComposedInput(textarea: HTMLTextAreaElement, init: InputEventInit): void {
  const input = new InputEvent('input', { ...init, bubbles: true })
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function updatePreedit(textarea: HTMLTextAreaElement, text: string): void {
  dispatchProcessKeydown(textarea)
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = text
  dispatchComposedInput(textarea, { data: text, inputType: 'insertCompositionText' })
}

describe('xterm IME composition cancellation', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('emits nothing when Backspace deletes the whole Pinyin preedit', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    for (const preedit of ['c', 'ce', 'ces', 'cesh', 'ceshi']) {
      updatePreedit(textarea, preedit)
      await nextEventLoop()
    }
    for (const preedit of ['cesh', 'ces', 'ce', 'c']) {
      updatePreedit(textarea, preedit)
      await nextEventLoop()
    }
    // Final Backspace: Chromium clears the preedit and ends the composition
    // with empty data; the last non-empty compositionupdate was 'c'.
    dispatchProcessKeydown(textarea)
    dispatchCompositionEvent(textarea, 'compositionupdate')
    textarea.value = ''
    dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('emits nothing when the preedit is cancelled without observed input events', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 'ce')
    textarea.value = 'ce'
    await nextEventLoop()
    dispatchCompositionEvent(textarea, 'compositionupdate', 'c')
    textarea.value = 'c'
    await nextEventLoop()
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('still emits an empty-end commit that delivers text via a following input event', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    await nextEventLoop()
    // IBus clears the textarea at compositionend, then restores the commit
    // through a bare insertText — evidence that this end was not a cancel.
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    textarea.value = '한'
    dispatchComposedInput(textarea, { data: '한', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })
})
