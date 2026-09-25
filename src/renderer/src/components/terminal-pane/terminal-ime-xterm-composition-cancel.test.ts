// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldSuppressTerminalImeKeyboardEvent,
  shouldSuppressTerminalModifierKeyboardEvent
} from './xterm-bypass-policy'

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

function openTerminal(options?: ConstructorParameters<typeof Terminal>[0]): {
  emitted: string[]
  terminal: Terminal
  textarea: HTMLTextAreaElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal(options)
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
  // happy-dom may drop InputEventInit.data the same way it drops CompositionEvent.data.
  Object.defineProperty(input, 'data', { value: init.data ?? null })
  Object.defineProperty(input, 'composed', { value: true })
  textarea.dispatchEvent(input)
}

function dispatchShiftProcessKeydown(textarea: HTMLTextAreaElement): void {
  const keydown = new KeyboardEvent('keydown', {
    key: 'Process',
    code: 'ShiftLeft',
    isComposing: true,
    bubbles: true,
    cancelable: true
  })
  Object.defineProperty(keydown, 'keyCode', { value: 229 })
  textarea.dispatchEvent(keydown)
}

function dispatchOrdinaryShiftKeydown(textarea: HTMLTextAreaElement, isComposing = true): void {
  const keydown = new KeyboardEvent('keydown', {
    key: 'Shift',
    code: 'ShiftLeft',
    isComposing,
    bubbles: true,
    cancelable: true,
    shiftKey: true
  })
  Object.defineProperty(keydown, 'keyCode', { value: 16 })
  textarea.dispatchEvent(keydown)
}

function attachPaneInputKeyHandler(
  terminal: Terminal,
  windowsComposing: Parameters<typeof shouldSuppressTerminalImeKeyboardEvent>[1]
): void {
  terminal.attachCustomKeyEventHandler((ev) => {
    if (shouldSuppressTerminalImeKeyboardEvent(ev, windowsComposing)) {
      return false
    }
    if (
      shouldSuppressTerminalModifierKeyboardEvent(ev, {
        isMac: windowsComposing.isMac,
        isLinux: windowsComposing.isLinux
      })
    ) {
      return false
    }
    return true
  })
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

  it('commits Sogou Electron Shift latin while the Process key is still down', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    const windowsComposing = {
      isMac: false,
      isLinux: false,
      compositionActive: true,
      candidateKeyGuardActive: true,
      pendingCandidateKeyReleaseActive: false
    }
    terminal.attachCustomKeyEventHandler(
      (ev) => !shouldSuppressTerminalImeKeyboardEvent(ev, windowsComposing)
    )

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 's')
    textarea.value = 's'
    await nextEventLoop()

    dispatchShiftProcessKeydown(textarea)

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()
    textarea.value = 's'
    dispatchComposedInput(textarea, { data: 's', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('s')
    terminal.dispose()
  })

  it('commits Sogou Shift latin when the pane handler would otherwise swallow Shift', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    const windowsComposing = {
      isMac: false,
      isLinux: false,
      compositionActive: true,
      candidateKeyGuardActive: true,
      pendingCandidateKeyReleaseActive: false
    }
    attachPaneInputKeyHandler(terminal, windowsComposing)

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 's')
    textarea.value = 's'
    await nextEventLoop()

    dispatchOrdinaryShiftKeydown(textarea)

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()
    textarea.value = 's'
    dispatchComposedInput(textarea, { data: 's', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('s')
    terminal.dispose()
  })

  it('commits Sogou Shift latin when ordinary Shift arrives after empty compositionend', async () => {
    const { emitted, terminal, textarea } = openTerminal()
    const windowsPostComposition = {
      isMac: false,
      isLinux: false,
      compositionActive: false,
      candidateKeyGuardActive: false,
      pendingCandidateKeyReleaseActive: false
    }
    attachPaneInputKeyHandler(terminal, windowsPostComposition)

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 's')
    textarea.value = 's'
    await nextEventLoop()

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()
    dispatchOrdinaryShiftKeydown(textarea, false)
    textarea.value = 's'
    dispatchComposedInput(textarea, { data: 's', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('s')
    terminal.dispose()
  })

  it('commits delayed latin after empty compositionend with Process key held (no custom handler)', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 's')
    textarea.value = 's'
    await nextEventLoop()

    dispatchShiftProcessKeydown(textarea)

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()
    textarea.value = 's'
    dispatchComposedInput(textarea, { data: 's', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('s')
    terminal.dispose()
  })

  it('does not emit delayed latin after Escape cancels a held-Process composition', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', 's')
    textarea.value = 's'
    await nextEventLoop()

    dispatchShiftProcessKeydown(textarea)

    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    await nextEventLoop()

    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true
      })
    )
    await nextEventLoop()

    textarea.value = 's'
    dispatchComposedInput(textarea, { data: 's', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('')
    terminal.dispose()
  })

  it('still emits an empty-end commit that delivers text via a following input event', async () => {
    const { emitted, terminal, textarea } = openTerminal()

    dispatchCompositionEvent(textarea, 'compositionstart')
    dispatchCompositionEvent(textarea, 'compositionupdate', '한')
    textarea.value = '한'
    await nextEventLoop()
    // IBus clears the textarea at compositionend, then restores the commit
    // through a bare insertText — evidence that this end was not a cancel.
    textarea.value = ''
    dispatchCompositionEvent(textarea, 'compositionend')
    textarea.value = '한'
    dispatchComposedInput(textarea, { data: '한', inputType: 'insertText' })
    await nextEventLoop()

    expect(emitted.join('')).toBe('한')
    terminal.dispose()
  })

  it('emits no kitty CSI-u for an idle Shift keydown under report-all-keys', async () => {
    // Why: idle Shift keydown is delivered so Sogou's post-compositionend commit
    // can land. CompositionHelper has to consume it; otherwise kitty encodes a
    // bare modifier press when REPORT_ALL_KEYS_AS_ESCAPE_CODES is on.
    const { emitted, terminal, textarea } = openTerminal({
      vtExtensions: { kittyKeyboard: true }
    })
    const windowsIdle = {
      isMac: false,
      isLinux: false,
      compositionActive: false,
      candidateKeyGuardActive: false,
      pendingCandidateKeyReleaseActive: false
    }
    attachPaneInputKeyHandler(terminal, windowsIdle)
    terminal.write('\x1b[=8u\x1b[?u')
    await nextEventLoop()
    expect(emitted.join('')).toBe('\x1b[?8u')
    emitted.length = 0

    dispatchOrdinaryShiftKeydown(textarea, false)
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })

  it('emits no kitty release for a Sogou Shift-coded Process keyup', async () => {
    // Why: REPORT_EVENT_TYPES forces a release CSI-u. The keyup must be
    // suppressed before xterm's encoder; the held latin commit does not need it.
    const { emitted, terminal, textarea } = openTerminal({
      vtExtensions: { kittyKeyboard: true }
    })
    const windowsComposing = {
      isMac: false,
      isLinux: false,
      compositionActive: true,
      candidateKeyGuardActive: true,
      pendingCandidateKeyReleaseActive: false
    }
    attachPaneInputKeyHandler(terminal, windowsComposing)
    terminal.write('\x1b[=2u\x1b[?u')
    await nextEventLoop()
    expect(emitted.join('')).toBe('\x1b[?2u')
    emitted.length = 0

    const keyup = new KeyboardEvent('keyup', {
      key: 'Process',
      code: 'ShiftRight',
      isComposing: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keyup, 'keyCode', { value: 229 })
    textarea.dispatchEvent(keyup)
    await nextEventLoop()

    expect(emitted).toEqual([])
    terminal.dispose()
  })
})
