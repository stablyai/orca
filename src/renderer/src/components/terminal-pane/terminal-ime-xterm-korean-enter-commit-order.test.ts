// @vitest-environment happy-dom
// Recorded Windows 11/MS Korean Enter arrives after compositionend as plain Enter; repeated final updates still produced 가 then CR (STA-3132). This gesture did not reproduce the suspected deferred force-end inversion; test that path separately.
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
  data = ''
): void {
  const event = new CompositionEvent(type, { bubbles: true })
  // happy-dom ignores CompositionEventInit.data, but Chromium supplies it.
  Object.defineProperty(event, 'data', { value: data })
  textarea.dispatchEvent(event)
}

function dispatchKeydown(
  textarea: HTMLTextAreaElement,
  init: { key: string; code: string; keyCode: number; isComposing: boolean }
): void {
  const keydown = new KeyboardEvent('keydown', {
    key: init.key,
    code: init.code,
    isComposing: init.isComposing,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(keydown, 'keyCode', { value: init.keyCode })
  textarea.dispatchEvent(keydown)
}

function dispatchComposedInput(textarea: HTMLTextAreaElement, data: string): void {
  const input = new InputEvent('input', {
    data,
    inputType: 'insertCompositionText',
    bubbles: true
  })
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.selectionStart = value.length
  textarea.selectionEnd = value.length
}

/** Recorded shape: a lead jamo key then a vowel key assemble one syllable (`r`+`k` → 가). */
async function composeSyllable(
  textarea: HTMLTextAreaElement,
  leadCode: string,
  jamo: string,
  syllable: string
): Promise<void> {
  dispatchKeydown(textarea, { key: 'Process', code: leadCode, keyCode: 229, isComposing: false })
  dispatchCompositionEvent(textarea, 'compositionstart')
  setValue(textarea, jamo)
  dispatchCompositionEvent(textarea, 'compositionupdate', jamo)
  dispatchComposedInput(textarea, jamo)
  await nextEventLoop()

  dispatchKeydown(textarea, { key: 'Process', code: 'KeyK', keyCode: 229, isComposing: true })
  setValue(textarea, syllable)
  dispatchCompositionEvent(textarea, 'compositionupdate', syllable)
  dispatchComposedInput(textarea, syllable)
  await nextEventLoop()

  // Third update: the IME re-reports the assembled syllable as it finalizes.
  dispatchCompositionEvent(textarea, 'compositionupdate', syllable)
  dispatchComposedInput(textarea, syllable)
  await nextEventLoop()
}

function composeGa(textarea: HTMLTextAreaElement): Promise<void> {
  return composeSyllable(textarea, 'KeyR', 'ㄱ', '가')
}

/** The recorded finalization: compositionend, and only then a plain Enter. */
async function finalizeThenEnter(textarea: HTMLTextAreaElement): Promise<void> {
  dispatchCompositionEvent(textarea, 'compositionend', '가')
  await nextEventLoop()
  setValue(textarea, '')
  dispatchKeydown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
  await nextEventLoop()
}

describe('STA-3132 — Korean commit reaches the PTY before the physical Enter', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('emits the committed syllable before the carriage return', async () => {
    const { emitted, textarea } = openTerminal()
    await composeGa(textarea)
    await finalizeThenEnter(textarea)

    const stream = emitted.join('')
    expect(stream).toContain('가')
    expect(stream).toContain('\r')
    // Recorded PTY bytes ea b0 80 0d require the syllable before CR; reversing them loses the submitted line’s last syllable.
    expect(stream.indexOf('가')).toBeLessThan(stream.indexOf('\r'))
    expect(stream).toBe('가\r')
  })
})
