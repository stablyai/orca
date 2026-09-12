// @vitest-environment happy-dom
// STA-3132 — Windows 11 / Microsoft Korean: compose a syllable, then press Enter.
//
// The event sequence replayed here is a recorded first-party trace, captured on awin
// (Windows 11 build 26200) against the defect-era v1.4.164 build with the Microsoft Korean
// IME (HKL 0412) driven by SendInput, with the bytes read back on the far side of the PTY by
// a raw-stdin reader. The two facts that shape this test, and that a synthesized trace would
// have gotten wrong, are:
//
//   * the physical Enter does NOT arrive during the composition. The IME finalizes first, so
//     Enter lands as a plain `Enter`/13 keydown with isComposing false, strictly after
//     compositionend; and
//   * there are three compositionupdates for two jamo keys — the IME re-reports the assembled
//     syllable once more as it finalizes.
//
// The PTY received `ea b0 80 0d` — 가 then CR, in that order, in a single write. This test
// pins that ordering: the committed syllable must reach the terminal before the newline, so a
// submitted line can never lose its last syllable to the next line.
//
// The capture did NOT reproduce the suspected defect, and that null is the useful part. The
// deferred-newline route could only invert this ordering via a session end carrying
// dataPendingReconciliation, which the vendored xterm patch dispatches from exactly one
// site — a compositionstart force-ending a still-pending prior session. Plain compose-then-Enter
// cannot reach it: the IME finalizes first, so Enter arrives with isComposing false and the
// newline was never held. Back-to-back arms at 25/60/120 ms attacked that precondition directly
// and still read `가\r나` every time. So the route is a real code-level hazard that this gesture
// does not reach on Windows + MS Korean.
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
    // The recorded PTY bytes were `ea b0 80 0d`. Anything that releases the newline first
    // submits a line whose last syllable has not been written yet.
    expect(stream.indexOf('가')).toBeLessThan(stream.indexOf('\r'))
    expect(stream).toBe('가\r')
  })

  it('leaves ordinary non-IME typing followed by Enter unchanged', async () => {
    const { emitted, textarea } = openTerminal()
    for (const key of ['a', 'b', 'c']) {
      dispatchKeydown(textarea, {
        key,
        code: `Key${key.toUpperCase()}`,
        keyCode: key.toUpperCase().charCodeAt(0),
        isComposing: false
      })
      await nextEventLoop()
    }
    dispatchKeydown(textarea, { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false })
    await nextEventLoop()

    // The paired latin arm of the same capture session read `61 62 63 0d` at the PTY.
    expect(emitted.join('')).toBe('abc\r')
  })

  // Restores coverage deleted with terminal-ime-hangul-syllable-flush.test.ts: #12278 fixed a
  // syllable that was not flushed before the next composition began, which is the force-end path
  // and the one that leaves stale glyphs behind. Recorded b2b arms read `가\r나` at 25/60/120 ms.
  it('keeps the first syllable when the next composition starts immediately', async () => {
    const { emitted, textarea } = openTerminal()
    await composeGa(textarea)
    await finalizeThenEnter(textarea)
    await composeSyllable(textarea, 'KeyS', 'ㄴ', '나')
    dispatchCompositionEvent(textarea, 'compositionend', '나')
    await nextEventLoop()

    const stream = emitted.join('')
    expect(stream).toBe('가\r나')
    // A dropped flush loses the leading syllable; a double flush repeats it.
    expect(stream.match(/가/g)).toHaveLength(1)
  })
})
