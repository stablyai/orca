// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): { emitted: string[]; terminal: Terminal; textarea: HTMLTextAreaElement } {
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

function dispatchComposedInput(textarea: HTMLTextAreaElement, init: InputEventInit): void {
  const input = new InputEvent('input', { ...init, bubbles: true })
  // happy-dom ignores InputEventInit.composed, but Chromium reports it for this path.
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function startSyllable(textarea: HTMLTextAreaElement): void {
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  dispatchCompositionEvent(textarea, 'compositionstart')
}

/**
 * One macOS Hangul syllable of a continuous run, as observed in Chromium.
 * The commit reaches the textarea as a bare value assignment: no `input` event
 * fires, because the next syllable's `compositionstart` preempts it.
 */
function composeSyllable(
  textarea: HTMLTextAreaElement,
  prefix: string,
  candidates: readonly string[],
  committed: string
): void {
  for (const candidate of candidates) {
    dispatchCompositionEvent(textarea, 'compositionupdate', candidate)
    textarea.value = `${prefix}${candidate}`
    dispatchComposedInput(textarea, { data: candidate, inputType: 'insertCompositionText' })
  }
  dispatchCompositionEvent(textarea, 'compositionend', committed)
  textarea.value = `${prefix}${committed}`
}

describe('xterm IME continuous Hangul run', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('commits each syllable before the next one starts composing', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    // The shell echoes what it receives; a syllable held back leaves the cursor parked,
    // so the next syllable's overlay paints over the cell the previous one should own.

    // 그: the ㄹ of 리 lands on 그 first, then peels off into the next syllable.
    startSyllable(textarea)
    composeSyllable(textarea, '', ['ㄱ', '그', '글', '그'], '그')
    startSyllable(textarea)
    await nextEventLoop()
    expect(emitted).toEqual(['그'])

    // 리: same shape, the ㄱ of 고 lands on 리 first.
    composeSyllable(textarea, '그', ['ㄹ', '리', '릭', '리'], '리')
    startSyllable(textarea)
    await nextEventLoop()
    expect(emitted).toEqual(['그', '리'])

    // 고 ends the run, so it takes the ordinary path.
    composeSyllable(textarea, '그리', ['ㄱ', '고'], '고')
    await nextEventLoop()
    expect(emitted).toEqual(['그', '리', '고'])

    terminal.dispose()
  })

  it('sends only the committed syllable when the next one already reached the textarea', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startSyllable(textarea)
    composeSyllable(textarea, '', ['ㄱ', '그', '글', '그'], '그')
    startSyllable(textarea)

    // The next syllable's first jamo lands before the deferred send runs, so the textarea
    // already reads 그ㄹ. Only the committed 그 may go out; nextCompositionStart is the bound.
    dispatchCompositionEvent(textarea, 'compositionupdate', 'ㄹ')
    textarea.value = '그ㄹ'
    dispatchComposedInput(textarea, { data: 'ㄹ', inputType: 'insertCompositionText' })
    await nextEventLoop()
    expect(emitted).toEqual(['그'])

    composeSyllable(textarea, '그', ['리'], '리')
    await nextEventLoop()
    expect(emitted).toEqual(['그', '리'])

    terminal.dispose()
  })
})
