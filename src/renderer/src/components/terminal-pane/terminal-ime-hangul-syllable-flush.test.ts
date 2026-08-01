// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(TerminalType: typeof EsmTerminal): {
  emitted: string[]
  terminal: EsmTerminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new TerminalType()
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, terminal, textarea: terminal.textarea }
}

function composition(
  textarea: HTMLTextAreaElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data?: string
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  if (data !== undefined) {
    Object.defineProperty(event, 'data', { value: data })
  }
  textarea.dispatchEvent(event)
}

function input(textarea: HTMLTextAreaElement, inputType: string, data?: string): void {
  const event = new InputEvent('input', { bubbles: true, data: data ?? null, inputType })
  // happy-dom ignores InputEventInit.composed, but Chromium reports it for this IBus path.
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

function keydown(textarea: HTMLTextAreaElement, key: string, code: string, keyCode: number): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, code, isComposing: true, key })
  Object.defineProperty(event, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(event)
}

/** macOS Hangul rewrites the whole syllable in place on every jamo keystroke. */
function composeSyllable(textarea: HTMLTextAreaElement, prefix: string, jamoSteps: string[]): void {
  textarea.setSelectionRange(prefix.length, prefix.length)
  composition(textarea, 'compositionstart')
  for (const step of jamoSteps) {
    composition(textarea, 'compositionupdate', step)
    textarea.value = `${prefix}${step}`
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('installed xterm Hangul syllable flush (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('flushes syllable N before syllable N+1 finishes composing', async () => {
    // macOS Hangul commits a syllable at the next syllable's compositionstart and sends no
    // insertText in between, so withholding here lags the terminal a full syllable behind.
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    composeSyllable(textarea, '', ['ㅎ', '하', '한'])
    composition(textarea, 'compositionend', '한')

    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionstart')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('preserves Korean final-consonant transfer', async () => {
    // A trailing consonant moves into the next syllable, so the textarea slice up to the next
    // compositionstart is authoritative over the '앙' that compositionend reported.
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    composeSyllable(textarea, '', ['ㅇ', '아', '앙'])
    composition(textarea, 'compositionend', '앙')

    textarea.value = '아아'
    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionstart')
    await nextEventLoop()

    expect(emitted.join('')).toBe('아')

    composition(textarea, 'compositionupdate', '아')
    textarea.setSelectionRange(2, 2)
    composition(textarea, 'compositionend', '아')
    await nextEventLoop()

    expect(emitted.join('')).toBe('아아')
    expect(emitted.join('')).not.toContain('앙')
    terminal.dispose()
  })

  it('emits 한글 exactly once', async () => {
    // The full two-syllable word must reach the PTY once, with no syllable resent at the boundary.
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    composeSyllable(textarea, '', ['ㅎ', '하', '한'])
    composition(textarea, 'compositionend', '한')
    composeSyllable(textarea, '한', ['ㄱ', '그', '글'])
    composition(textarea, 'compositionend', '글')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한글')
    terminal.dispose()
  })

  it('does not double-send when an insertText input event follows compositionend', async () => {
    // IBus clears the preedit and re-inserts the commit as insertText before the next
    // compositionstart, so that insertText already owns the flush.
    const { emitted, terminal, textarea } = openTerminal(TerminalType)
    textarea.setSelectionRange(0, 0)
    composition(textarea, 'compositionstart')
    keydown(textarea, 'Process', 'KeyG', 229)
    composition(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    input(textarea, 'insertCompositionText', '한')

    composition(textarea, 'compositionupdate')
    textarea.value = ''
    input(textarea, 'deleteContentBackward')
    composition(textarea, 'compositionend')
    textarea.value = '한'
    input(textarea, 'insertText', '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')

    textarea.setSelectionRange(1, 1)
    composition(textarea, 'compositionstart')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })
})
