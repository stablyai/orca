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
    code: 'KeyC',
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

function updatePreedit(textarea: HTMLTextAreaElement, text: string): void {
  dispatchProcessKeydown(textarea)
  dispatchCompositionEvent(textarea, 'compositionupdate', text)
  textarea.value = text
  dispatchComposedInput(textarea, { data: text, inputType: 'insertCompositionText' })
}

describe('xterm IME composition cancellation', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('emits nothing when Backspace deletes the whole Pinyin preedit', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    for (const preedit of ['c', 'ce', 'ces', 'cesh', 'ceshi']) {
      updatePreedit(textarea, preedit)
      await nextEventLoop()
    }
    for (const preedit of ['cesh', 'ces', 'ce', 'c']) {
      updatePreedit(textarea, preedit)
      await nextEventLoop()
    }
    // Final Backspace: Chromium clears the preedit and ends the composition
    // with empty data; the last non-empty compositionupdate was 'c'.
    dispatchProcessKeydown(textarea)
    dispatchCompositionEvent(textarea, 'compositionupdate')
    textarea.value = ''
    dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('drops a Sogou preedit cancelled without a trailing input event', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    for (const preedit of ['nihao', 'niha', 'nih', 'ni', 'n']) {
      dispatchCompositionEvent(textarea, 'compositionupdate', preedit)
      textarea.value = preedit
      await nextEventLoop()
    }
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('still emits an empty-end commit that delivers text via a following input event', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchProcessKeydown(textarea)
    dispatchCompositionEvent(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    await nextEventLoop()
    dispatchCompositionEvent(textarea, 'compositionupdate')
    textarea.value = ''
    dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
    dispatchCompositionEvent(textarea, 'compositionend')
    textarea.value = '한'
    dispatchComposedInput(textarea, { data: '한', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  // Source: tests/e2e/terminal-macos-cangjie-native.spec.ts RECORDED_CANGJIE_CANCEL_BOUNDARIES,
  // captured on real macOS built-in Cangjie; fresh PTY-boundary run
  // .tmp/ime-handoff/evidence/macos-11951-cangjie-2026-08-06/
  //   native-macos-cangjie-removes-cancelled-preedit-without-writing-it-to-the-pty.json
  // SHA-256: 889f267d284bca411f75042e393beb9dfe626fcd894f50b0c9d0654013f6373b
  // That run's own onData is ["o","r","d","i","n","a","r","y","\r"] — the cancelled 尸 contributes
  // nothing. Cangjie's cancel differs from the Pinyin case above: one keystroke, then Backspace
  // arrives as deleteContentBackward with data null and an empty compositionend, so the stale
  // preedit is the ONLY thing a fallback could replay.
  it('emits nothing when Backspace cancels the recorded Cangjie preedit', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    const keydown = new KeyboardEvent('keydown', {
      key: '尸',
      code: 'KeyS',
      isComposing: false,
      bubbles: true
    })
    Object.defineProperty(keydown, 'keyCode', { value: 229 })
    textarea.dispatchEvent(keydown)
    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '尸')
    textarea.value = '尸'
    dispatchComposedInput(textarea, { data: '尸', inputType: 'insertCompositionText' })

    const backspace = new KeyboardEvent('keydown', {
      key: 'Backspace',
      isComposing: true,
      bubbles: true
    })
    Object.defineProperty(backspace, 'keyCode', { value: 229 })
    textarea.dispatchEvent(backspace)
    dispatchCompositionEvent(textarea, 'compositionupdate')
    textarea.value = ''
    dispatchComposedInput(textarea, { inputType: 'deleteContentBackward' })
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  // The same capture's paired control, typed with no composition in flight. It must stay green
  // under the historical bundle: the defect is specific to the cancellation fallback, and a
  // negative that also breaks would prove nothing about which path is at fault.
  it('delivers the recorded ordinary control with no composition in flight', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    for (const character of 'ordinary') {
      const keypress = new KeyboardEvent('keypress', { key: character, bubbles: true })
      const charCode = character.charCodeAt(0)
      Object.defineProperties(keypress, {
        charCode: { value: charCode },
        keyCode: { value: charCode },
        which: { value: charCode }
      })
      textarea.dispatchEvent(keypress)
    }
    await nextEventLoop()

    expect(emitted.join('')).toBe('ordinary')
    terminal.dispose()
  })
})
