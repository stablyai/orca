// @vitest-environment happy-dom
// STA-3250 arm: continuous Korean 2-Set typing, NO Enter, sampled at every
// syllable boundary. Measures how many syllable boundaries pass between a
// compositionend and the syllable reaching onData.
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
    code: 'KeyR',
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

function setValue(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value
  textarea.selectionStart = value.length
  textarea.selectionEnd = value.length
}

/**
 * macOS Korean 2-Set: a syllable is committed only when the FIRST jamo of the
 * next syllable arrives. Chromium then fires compositionend(previous syllable)
 * immediately followed by compositionstart for the new one, in the same task.
 */
async function typeSyllables(
  textarea: HTMLTextAreaElement,
  emitted: string[],
  syllables: { preedits: string[] }[]
): Promise<string[][]> {
  const emittedAtEachBoundary: string[][] = []
  let committed = ''
  let composing = false

  for (const syllable of syllables) {
    const [first, ...rest] = syllable.preedits
    dispatchProcessKeydown(textarea)
    if (composing) {
      // Commit the previous syllable, then open the new one in the SAME task.
      dispatchCompositionEvent(textarea, 'compositionend', committed.slice(-1))
    }
    dispatchCompositionEvent(textarea, 'compositionstart')
    composing = true
    setValue(textarea, committed + first)
    dispatchCompositionEvent(textarea, 'compositionupdate', first)
    dispatchComposedInput(textarea, { data: first, inputType: 'insertCompositionText' })
    await nextEventLoop()

    for (const preedit of rest) {
      dispatchProcessKeydown(textarea)
      setValue(textarea, committed + preedit)
      dispatchCompositionEvent(textarea, 'compositionupdate', preedit)
      dispatchComposedInput(textarea, { data: preedit, inputType: 'insertCompositionText' })
      await nextEventLoop()
    }
    committed += syllable.preedits.at(-1)
    emittedAtEachBoundary.push([...emitted])
  }
  return emittedAtEachBoundary
}

// 한글하다 — four syllables, continuous, no Enter and no Space.
const HANGUL_PHRASE = [
  { preedits: ['ㅎ', '하', '한'] },
  { preedits: ['ㄱ', '그', '글'] },
  { preedits: ['ㅎ', '하'] },
  { preedits: ['ㄷ', '다'] }
]

const LATIN_PHRASE = ['a', 'b', 'c', 'd']

describe('STA-3250 — continuous Korean typing, no Enter', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('reaches onData within the same syllable it was committed in', async () => {
    const { emitted, textarea } = openTerminal()
    const snapshots = await typeSyllables(textarea, emitted, HANGUL_PHRASE)

    // Reported diagnostic: what onData holds once each syllable has been typed.
    console.log('[STA-3250] per-syllable onData:', JSON.stringify(snapshots))
    console.log('[STA-3250] final onData:', JSON.stringify(emitted))

    // After syllable 2 (글) has been typed, 한 was committed one syllable ago and
    // must already have reached onData.
    expect(snapshots[1].join('')).toBe('한')
    // After syllable 3 (하), both 한 and 글 must have reached onData.
    expect(snapshots[2].join('')).toBe('한글')
    // After syllable 4 (다), 한글하 must have reached onData.
    expect(snapshots[3].join('')).toBe('한글하')
  })

  it('length-matched ASCII negative: every keystroke reaches onData immediately', async () => {
    const { emitted, textarea } = openTerminal()
    const snapshots: string[][] = []
    for (const ch of LATIN_PHRASE) {
      const keydown = new KeyboardEvent('keydown', {
        key: ch,
        code: `Key${ch.toUpperCase()}`,
        bubbles: true
      })
      Object.defineProperty(keydown, 'keyCode', { value: ch.toUpperCase().charCodeAt(0) })
      textarea.dispatchEvent(keydown)
      await nextEventLoop()
      snapshots.push([...emitted])
    }
    console.log('[STA-3250 ascii] per-key onData:', JSON.stringify(snapshots))
    expect(snapshots.map((s) => s.join(''))).toEqual(['a', 'ab', 'abc', 'abcd'])
  })
})
