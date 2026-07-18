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

function startComposition(textarea: HTMLTextAreaElement, text: string): void {
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
  textarea.value = text
}

function dispatchKeypress(textarea: HTMLTextAreaElement, text: string): void {
  const keypress = new KeyboardEvent('keypress', { key: text, bubbles: true })
  // happy-dom omits Chromium's legacy charCode field that xterm still reads.
  Object.defineProperty(keypress, 'charCode', { value: text.charCodeAt(0) })
  textarea.dispatchEvent(keypress)
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

  it('emits a post-composition IBus Hangul keypress only once', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    // Why: IBus clears at compositionend, then restores the same commit after
    // xterm's keypress path has already emitted it.
    textarea.value = ''
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    const compositionHelper = (
      terminal as unknown as {
        _core: {
          _compositionHelper: {
            _isSendingComposition: boolean
            _pendingKeypressData: string
          }
        }
      }
    )._core._compositionHelper
    expect(compositionHelper._isSendingComposition).toBe(true)
    dispatchKeypress(textarea, '한')
    expect(compositionHelper._pendingKeypressData).toBe('한')
    expect(emitted).toEqual([])
    textarea.value = '한'
    textarea.dispatchEvent(
      new InputEvent('input', { data: '한', inputType: 'insertText', bubbles: true })
    )
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('preserves composition-first order when keypress overlaps its suffix', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '가한')
    await nextEventLoop()

    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('가한')
    terminal.dispose()
  })

  it('emits unmatched keypress before propagated composition text', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'a', bubbles: true }))
    textarea.value = 'a'
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('does not repeat keypress contained before propagated composition text', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.dispatchEvent(
      new CompositionEvent('compositionupdate', { data: '한a', bubbles: true })
    )
    textarea.value = '한a'
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('merges multiple deferred keypresses with partial textarea overlap', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    dispatchKeypress(textarea, 'a')
    dispatchKeypress(textarea, 'b')
    textarea.value = '한a'
    await nextEventLoop()

    expect(emitted.join('')).toBe('한ab')
    terminal.dispose()
  })

  it('reconciles buffered keypress before immediate keydown finalization', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.value = ''
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    dispatchKeypress(textarea, '한')
    textarea.value = '한'
    const keydown = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })
    Object.defineProperty(keydown, 'keyCode', { value: 65 })
    textarea.dispatchEvent(keydown)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })
})
