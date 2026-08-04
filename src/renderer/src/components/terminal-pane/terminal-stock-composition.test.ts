// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

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

  it('uses the recorded macOS committed text instead of the keydown layout text', () => {
    const { emitted, terminal, textarea } = openTerminal()
    terminal.attachCustomKeyEventHandler(
      (event) =>
        !shouldBypassXtermKeyboardEvent(event, {
          isMac: true,
          hasSelection: false
        })
    )
    keydown(textarea, '₩', 192)
    const keypress = new KeyboardEvent('keypress', {
      bubbles: true,
      code: 'Backquote',
      key: '₩'
    })
    Object.defineProperties(keypress, {
      charCode: { value: 96 },
      keyCode: { value: 96 },
      which: { value: 96 }
    })
    textarea.dispatchEvent(keypress)
    textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '₩' }))
    keydown(textarea, 'a', 65)

    expect(emitted.join('')).toBe('`a')
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

  it('orders application input after the recorded committing composition', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '하')
    textarea.value = '하'
    textarea.setSelectionRange(1, 1)
    terminal.input('\x1b\r')
    composition(textarea, 'compositionend', '하')
    await nextTask()

    expect(emitted.join('')).toBe('하\x1b\r')
    terminal.dispose()
  })

  it('orders application input after a native insertText commit', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '한')
    composition(textarea, 'compositionend')
    terminal.input('\x1b\r')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: '한', inputType: 'insertText' })
    )
    await nextTask()

    expect(emitted.join('')).toBe('한\x1b\r')
    terminal.dispose()
  })

  it('releases application input queued during the late-commit window', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionend', '한')
    await nextTask()

    terminal.input('\x1b\r')
    await nextTask()

    expect(emitted.join('')).toBe('한\x1b\r')
    terminal.dispose()
  })

  it('leaves application input immediate outside composition', () => {
    const { emitted, terminal } = openTerminal()
    terminal.input('\x1b\r')

    expect(emitted.join('')).toBe('\x1b\r')
    terminal.dispose()
  })

  it('delivers same-task composition ranges before physical Enter', () => {
    const { emitted, terminal, textarea } = openTerminal()

    for (const value of ['ㅐ', 'ㅐㅏ', 'ㅐㅏ묘']) {
      composition(textarea, 'compositionstart')
      composition(textarea, 'compositionupdate', value.slice(-1))
      textarea.value = value
      textarea.setSelectionRange(value.length, value.length)
      composition(textarea, 'compositionend', value.slice(-1))
    }
    keydown(textarea, 'Enter', 13)

    expect(emitted.join('')).toBe('ㅐㅏ묘\r')
    terminal.dispose()
  })

  it('does not duplicate an IBus commit after the opening Process key', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    keydown(textarea, 'Process', 229)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '한')
    textarea.value = ''
    textarea.setSelectionRange(0, 0)
    composition(textarea, 'compositionend')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    textarea.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: '한', inputType: 'insertText' })
    )
    await nextTask()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('does not duplicate an IBus insertText delivered after the deferred range', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    keydown(textarea, 'Process', 229)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionend')
    await nextTask()
    textarea.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: '한', inputType: 'insertText' })
    )
    await nextTask()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })
})
