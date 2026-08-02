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

function typeObservedAscii(textarea: HTMLTextAreaElement, text: string): void {
  for (const character of text) {
    dispatchKeydown(textarea, character, `Key${character.toUpperCase()}`, character.charCodeAt(0))
    textarea.value += character
    dispatchComposedInput(textarea, { data: character, inputType: 'insertText' })
  }
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

function typeObservedIbusCommit(textarea: HTMLTextAreaElement, text: string): void {
  const prefix = startObservedIbusComposition(textarea, text)
  commitObservedIbusComposition(textarea, prefix, text)
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

function getCompositionHelper(terminal: Terminal): {
  keypress(text: string): boolean
} {
  return (
    terminal as unknown as {
      _core: { _compositionHelper: { keypress(text: string): boolean } }
    }
  )._core._compositionHelper
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

  it('emits a propagated IBus Hangul commit exactly once', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusCommit(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('does not drop an unpropagated IBus commit before the following keydown', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchKeydown(textarea, 'a', 'KeyA', 65)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
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

  it('leaves ordinary ASCII outside composition bookkeeping', () => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedAscii(textarea, 'abcdefghijklmno')

    expect(emitted.join('')).toBe('abcdefghijklmno')
    expect(getPendingFinalizationCount(terminal)).toBe(0)
    terminal.dispose()
  })

  it.each(['日本語', '中文'])('preserves a propagated %s IME commit', async (text) => {
    const { emitted, terminal, textarea } = openTerminal()

    typeObservedIbusCommit(textarea, text)
    await nextEventLoop()

    expect(emitted.join('')).toBe(text)
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

  it('keeps an unmatched Japanese keypress after its composition', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '日')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend', '日')
    dispatchKeypress(textarea, '本')
    await nextEventLoop()

    expect(emitted.join('')).toBe('日本')
    terminal.dispose()
  })

  it('keeps unrelated text after the composition that preceded it', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '漢')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend', '漢')
    dispatchKeypress(textarea, 'x')
    await nextEventLoop()

    expect(emitted.join('')).toBe('漢x')
    terminal.dispose()
  })

  it.each([
    ['日本', '本'],
    ['가나다', '다'],
    ['🇰🇷', '🇰'],
    ['👩‍💻', '💻'],
    ['가', '가'],
    ['👍🏽', '👍🏽'],
    ['e\u0301', '\u0301'],
    ['中文', '文'],
    ['한', 'a'],
    ['a', 'a']
  ])('keeps immediately-following %s then %s input distinct', async (composition, following) => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, composition)
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend', composition)
    textarea.value = `${composition}${following}`
    dispatchComposedInput(textarea, { data: following, inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe(`${composition}${following}`)
    terminal.dispose()
  })

  it('emits repeated Korean insertText within one composition exactly twice', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '가가')
    await nextEventLoop()

    dispatchComposedInput(textarea, { data: '가', inputType: 'insertText' })
    dispatchComposedInput(textarea, { data: '가', inputType: 'insertText' })
    dispatchCompositionEvent(textarea, 'compositionend', '가가')
    await nextEventLoop()

    expect(emitted.join('')).toBe('가가')
    terminal.dispose()
  })

  it('owns Chinese insertText that arrives before compositionend', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '中文')
    await nextEventLoop()

    dispatchComposedInput(textarea, { data: '中文', inputType: 'insertText' })
    dispatchCompositionEvent(textarea, 'compositionend', '中文')
    await nextEventLoop()

    expect(emitted.join('')).toBe('中文')
    terminal.dispose()
  })

  it('does not scan large unrelated observations for partial overlap', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    const composition = 'a'.repeat(10_000)
    const following = 'b'.repeat(50_000)
    startComposition(textarea, composition)
    await nextEventLoop()
    dispatchCompositionEvent(textarea, 'compositionend', composition)
    const endsWith = vi.spyOn(String.prototype, 'endsWith')
    const startsWith = vi.spyOn(String.prototype, 'startsWith')

    expect(getCompositionHelper(terminal).keypress(following)).toBe(false)
    await nextEventLoop()

    expect(emitted.join('')).toBe(composition)
    expect(endsWith).not.toHaveBeenCalled()
    expect(startsWith).not.toHaveBeenCalled()
    terminal.dispose()
  })

  it('preserves a Korean final-consonant transfer across compositions', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, 'ㅇ')
    updateObservedIbusComposition(textarea, '', '아')
    updateObservedIbusComposition(textarea, '', '앙')
    dispatchCompositionEvent(textarea, 'compositionend', '앙')
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    updateObservedIbusComposition(textarea, '아', '아')
    dispatchCompositionEvent(textarea, 'compositionend', '아')
    await nextEventLoop()

    expect(emitted.join('')).toBe('아아')
    terminal.dispose()
  })

  it('uses the authoritative IBus insertText after a final-consonant transfer', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    const prefix = startObservedIbusComposition(textarea, '텟')
    await nextEventLoop()

    endObservedIbusComposition(textarea, prefix)
    textarea.value = '테'
    dispatchComposedInput(textarea, { data: '테', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('테')
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

  it('keeps a deferred composition update scoped to its transaction', async () => {
    const { terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchComposedInput(textarea, { data: '한', inputType: 'insertText' })
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionstart')
    textarea.value = '한글'
    textarea.setSelectionRange(2, 2)
    await nextEventLoop()

    const compositionPosition = (
      terminal as unknown as {
        _core: { _compositionHelper: { _compositionPosition: { start: number; end: number } } }
      }
    )._core._compositionHelper._compositionPosition
    expect(compositionPosition).toEqual({ start: 1, end: 1 })
    dispatchCompositionEvent(textarea, 'compositionend', '글')
    await nextEventLoop()
    terminal.dispose()
  })

  it('preserves a retained commit before a no-keydown text insertion', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    textarea.value = '한x'
    dispatchComposedInput(textarea, { data: 'x', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('한x')
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

  it('flushes an unpropagated Hangul commit before Enter', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startObservedIbusComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchKeydown(textarea, 'Enter', 'Enter', 13)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한\r')
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

  it('ignores a duplicate compositionend for the same transaction', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    startComposition(textarea, '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    dispatchCompositionEvent(textarea, 'compositionend', '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    expect(getPendingFinalizationCount(terminal)).toBe(0)
    terminal.dispose()
  })

  it('ignores a stale compositionend after the next transaction starts', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 'A')
    textarea.value = 'A'
    textarea.setSelectionRange(1, 1)
    dispatchCompositionEvent(textarea, 'compositionend', 'A')

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 'B')
    dispatchCompositionEvent(textarea, 'compositionend', 'A')
    dispatchCompositionEvent(textarea, 'compositionend', 'B')
    await nextEventLoop()

    expect(emitted.join('')).toBe('AB')
    terminal.dispose()
  })

  it('bounds pending finalizations during synchronous composition turnover', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    for (let index = 0; index < 20; index++) {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      dispatchCompositionEvent(textarea, 'compositionstart')
      dispatchCompositionEvent(textarea, 'compositionupdate', '가')
      textarea.value += '가'
      dispatchCompositionEvent(textarea, 'compositionend', '가')
      expect(getPendingFinalizationCount(terminal)).toBeLessThanOrEqual(1)
    }
    await nextEventLoop()

    expect(emitted.join('')).toBe('가'.repeat(20))
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

  it('flushes a pending commit before blur clears the textarea', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    terminal.focus()
    startComposition(textarea, '한')

    dispatchCompositionEvent(textarea, 'compositionend', '한')
    textarea.blur()
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('flushes an active composition before blur clears the textarea', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    terminal.focus()
    startComposition(textarea, '한')

    textarea.blur()
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
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

  it('emits a post-composition IBus Hangul keypress only once', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    // Why: IBus clears at compositionend, then restores the same commit after
    // xterm's keypress path has already emitted it.
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    const compositionHelper = (
      terminal as unknown as {
        _core: {
          _compositionHelper: { _pendingComposition?: { keypressData: string } }
        }
      }
    )._core._compositionHelper
    expect(compositionHelper._pendingComposition).toBeDefined()
    dispatchKeypress(textarea, '한')
    expect(compositionHelper._pendingComposition?.keypressData).toBe('한')
    expect(emitted).toEqual([])
    textarea.value = '한'
    textarea.dispatchEvent(
      new InputEvent('input', { data: '한', inputType: 'insertText', bubbles: true })
    )
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('keeps a following keypress even when it matches the composition suffix', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '가한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('가한한')
    terminal.dispose()
  })

  it('emits propagated composition text before an unmatched keypress', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionupdate', 'a')
    textarea.value = 'a'
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('a한')
    terminal.dispose()
  })

  it('keeps a following keypress even when it matches the composition prefix', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    dispatchCompositionEvent(textarea, 'compositionupdate', '한a')
    textarea.value = '한a'
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a한')
    terminal.dispose()
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

  it('reconciles buffered keypress before immediate keydown finalization', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    dispatchKeypress(textarea, '한')
    textarea.value = '한'
    const keydown = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true })
    Object.defineProperty(keydown, 'keyCode', { value: 65 })
    textarea.dispatchEvent(keydown)
    await nextEventLoop()

    expect(emitted.join('')).toBe('한a')
    terminal.dispose()
  })

  it('preserves macOS Korean commit boundaries across blur and refocus', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '하')
    dispatchCompositionEvent(textarea, 'compositionend', '하')
    textarea.dispatchEvent(new FocusEvent('blur'))
    textarea.dispatchEvent(new FocusEvent('focus'))
    startComposition(textarea, 'ㄴ ')
    dispatchCompositionEvent(textarea, 'compositionend', 'ㄴ ')
    await nextEventLoop()

    expect(emitted.join('')).toBe('하ㄴ ')
    terminal.dispose()
  })

  it('commits the visible composition when pane blur precedes compositionend', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.dispatchEvent(new FocusEvent('blur'))
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('commits to the composing terminal when focus switches to another terminal', async () => {
    const original = openTerminal()
    const unrelated = openTerminal()
    startComposition(original.textarea, '한')
    await nextEventLoop()

    original.textarea.dispatchEvent(
      new CompositionEvent('compositionend', { data: '한', bubbles: true })
    )
    original.textarea.dispatchEvent(new FocusEvent('blur'))
    unrelated.textarea.focus()
    await nextEventLoop()

    expect(original.emitted.join('')).toBe('한')
    expect(unrelated.emitted).toEqual([])
    original.terminal.dispose()
    unrelated.terminal.dispose()
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

  it('cancels a pending completion when Escape follows compositionend', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    startComposition(textarea, '한')
    await nextEventLoop()

    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한', bubbles: true }))
    dispatchKeydown(textarea, 'Escape', 'Escape', 229, true, 100)
    dispatchKeydown(textarea, 'Escape', 'Escape', 27, false, 100)
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })
})
