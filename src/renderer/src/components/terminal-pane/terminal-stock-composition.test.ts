// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function openTerminal(): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm helper textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea: terminal.textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function keydown(
  textarea: HTMLTextAreaElement,
  key: string,
  keyCode: number,
  isComposing = false
): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, isComposing, key })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

describe('stock xterm composition ownership', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('delivers a commit before a same-task next composition', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '가')
    textarea.value = '가'
    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionend', '가')

    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '나')
    textarea.value = '가나'
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', '나')
    await nextTask()

    expect(emitted.join('')).toBe('가나')
    terminal.dispose()
  })

  it('leaves ordinary non-IME typing and Enter unchanged', () => {
    const { emitted, terminal, textarea } = openTerminal()
    keydown(textarea, 'a', 65)
    keydown(textarea, 'b', 66)
    keydown(textarea, 'Enter', 13)

    expect(emitted.join('')).toBe('ab\r')
    terminal.dispose()
  })

  it('delivers the commit before the physical Enter', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    await nextTask()
    composition(textarea, 'compositionend', '한')
    keydown(textarea, 'Enter', 13)

    expect(emitted.join('')).toBe('한\r')
    terminal.dispose()
  })
})
