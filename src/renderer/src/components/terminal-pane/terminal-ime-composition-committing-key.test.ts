// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { Terminal as EsmTerminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: Space and Enter both commit a live Hangul composition and are ordinary
// terminal input in the same keystroke. When the IME reports the commit through
// its own insertText event, xterm defers that keypress behind the pending
// composition — it must still reach the PTY once the commit is reconciled.

const requireFromHere = createRequire(import.meta.url)
const { Terminal: CjsTerminal } = requireFromHere('@xterm/xterm') as {
  Terminal: typeof EsmTerminal
}
const openTerminals: EsmTerminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(TerminalType: typeof EsmTerminal): {
  emitted: string[]
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new TerminalType()
  openTerminals.push(terminal)
  terminal.open(container)
  if (!terminal.textarea) {
    throw new Error('xterm textarea was not created')
  }
  const emitted: string[] = []
  terminal.onData((data) => emitted.push(data))
  return { emitted, textarea: terminal.textarea }
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
  Object.defineProperty(event, 'composed', { value: true })
  textarea.dispatchEvent(event)
}

function keypress(textarea: HTMLTextAreaElement, key: string, keyCode: number): void {
  const event = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key })
  Object.defineProperties(event, {
    charCode: { value: keyCode },
    keyCode: { value: keyCode },
    which: { value: keyCode }
  })
  textarea.dispatchEvent(event)
}

/**
 * Replays the commit shape where the IME withdraws its preedit before
 * compositionend and reports the committed syllable as a separate insertText.
 * The committing keydown never reaches xterm: the pane bypasses every keyboard
 * event the IME owns (see xterm-bypass-policy.ts).
 */
function commitThroughInsertText(
  textarea: HTMLTextAreaElement,
  syllable: string,
  committingKey: { key: string; keyCode: number }
): void {
  textarea.setSelectionRange(0, 0)
  composition(textarea, 'compositionstart')
  composition(textarea, 'compositionupdate', syllable)
  textarea.value = syllable
  textarea.setSelectionRange(syllable.length, syllable.length)
  input(textarea, 'insertCompositionText', syllable)
  composition(textarea, 'compositionupdate')
  textarea.value = ''
  textarea.setSelectionRange(0, 0)
  input(textarea, 'deleteContentBackward')
  composition(textarea, 'compositionend')
  keypress(textarea, committingKey.key, committingKey.keyCode)
  textarea.value = syllable
  textarea.setSelectionRange(syllable.length, syllable.length)
  input(textarea, 'insertText', syllable)
}

describe.each([
  ['ESM', EsmTerminal],
  ['CJS', CjsTerminal]
])('installed xterm IME committing key (%s)', (_format, TerminalType) => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('keeps the space that commits the syllable', async () => {
    const { emitted, textarea } = openTerminal(TerminalType)
    commitThroughInsertText(textarea, '이', { key: ' ', keyCode: 32 })
    await nextEventLoop()

    expect(emitted.join('')).toBe('이 ')
  })

  it('keeps the newline that commits the syllable', async () => {
    const { emitted, textarea } = openTerminal(TerminalType)
    commitThroughInsertText(textarea, '상', { key: '\r', keyCode: 13 })
    await nextEventLoop()

    expect(emitted.join('')).toBe('상\r')
  })

  it('does not duplicate a committing key the textarea already carries', async () => {
    const { emitted, textarea } = openTerminal(TerminalType)
    textarea.setSelectionRange(0, 0)
    composition(textarea, 'compositionstart')
    composition(textarea, 'compositionupdate', '이')
    textarea.value = '이'
    textarea.setSelectionRange(1, 1)
    input(textarea, 'insertCompositionText', '이')
    composition(textarea, 'compositionend', '이')
    keypress(textarea, ' ', 32)
    textarea.value = '이 '
    textarea.setSelectionRange(2, 2)
    input(textarea, 'insertText', ' ')
    await nextEventLoop()

    expect(emitted.join('')).toBe('이 ')
  })

  it('sends a second space once the commit has already flushed', async () => {
    const { emitted, textarea } = openTerminal(TerminalType)
    commitThroughInsertText(textarea, '이', { key: ' ', keyCode: 32 })
    keypress(textarea, ' ', 32)
    await nextEventLoop()

    expect(emitted.join('')).toBe(`이${' '.repeat(2)}`)
  })
})
