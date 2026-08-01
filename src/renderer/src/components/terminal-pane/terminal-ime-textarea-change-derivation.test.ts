// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Covers the patched CompositionHelper._handleAnyTextareaChanges path: a bare
// keydown-229 outside a composition, which is how an active IME delivers plain
// punctuation and digits. xterm-bypass-policy.ts routes that keydown into xterm
// on macOS and Linux instead of suppressing it, so this is live product behavior.
//
// The method used to derive the new text as `newValue.replace(oldValue, '')`,
// which removes the first occurrence of the old value anywhere in the new one —
// see the IME rule in AGENTS.md about never diffing two buffer observations.

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(): { emitted: string[]; textarea: HTMLTextAreaElement } {
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
  return { emitted, textarea }
}

function setBuffer(textarea: HTMLTextAreaElement, value: string, caret: number): void {
  textarea.value = value
  textarea.selectionStart = caret
  textarea.selectionEnd = caret
}

function dispatchKeydown(textarea: HTMLTextAreaElement, keyCode: number): void {
  const keydown = new KeyboardEvent('keydown', { bubbles: true, key: 'Process' })
  Object.defineProperty(keydown, 'keyCode', { value: keyCode })
  textarea.dispatchEvent(keydown)
}

/** Snapshot happens on the keydown; the IME writes the buffer before the timer runs. */
async function typeWithImeActive(
  textarea: HTMLTextAreaElement,
  before: { value: string; caret: number },
  after: { value: string; caret: number }
): Promise<void> {
  setBuffer(textarea, before.value, before.caret)
  dispatchKeydown(textarea, 229)
  setBuffer(textarea, after.value, after.caret)
  await nextEventLoop()
}

describe('non-composition text entered while an IME is active', () => {
  beforeEach(() => {
    // xterm's DOM renderer measures glyphs through a canvas happy-dom does not provide.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends only the inserted glyph when the caret is not at the end', async () => {
    // The regression case. "ab" with the caret between the two characters gains an
    // "x": the old value is no longer a substring of the new one, so the removal
    // matched nothing and the whole buffer went to the pty as "axb".
    const { emitted, textarea } = openTerminal()

    await typeWithImeActive(textarea, { caret: 1, value: 'ab' }, { caret: 2, value: 'axb' })

    expect(emitted).toEqual(['x'])
  })

  it('sends the appended glyph for the ordinary end-of-buffer case', async () => {
    const { emitted, textarea } = openTerminal()

    await typeWithImeActive(textarea, { caret: 0, value: '' }, { caret: 1, value: '1' })

    expect(emitted).toEqual(['1'])
  })

  it('emits nothing when the caret does not account for the growth', async () => {
    // Two characters appeared but the caret advanced by one, so which of them the
    // user typed is unknowable. Guessing here writes junk into a live shell.
    const { emitted, textarea } = openTerminal()

    await typeWithImeActive(textarea, { caret: 1, value: 'ab' }, { caret: 2, value: 'axbz' })

    expect(emitted).toEqual([])
  })

  it('sends a single delete when the buffer shrank', async () => {
    const { emitted, textarea } = openTerminal()

    await typeWithImeActive(textarea, { caret: 2, value: 'ab' }, { caret: 1, value: 'a' })

    expect(emitted).toEqual([''])
  })

  it('leaves an unchanged buffer silent', async () => {
    const { emitted, textarea } = openTerminal()

    await typeWithImeActive(textarea, { caret: 1, value: 'a' }, { caret: 1, value: 'a' })

    expect(emitted).toEqual([])
  })

  it('does not open the IME path for an ordinary keystroke', async () => {
    // The paired negative: without the 229 marker the buffer is never inspected,
    // so a mutation that would have been forwarded above stays silent here.
    const { emitted, textarea } = openTerminal()

    setBuffer(textarea, 'ab', 1)
    dispatchKeydown(textarea, 65)
    setBuffer(textarea, 'axb', 2)
    await nextEventLoop()

    expect(emitted).toEqual([])
  })
})
