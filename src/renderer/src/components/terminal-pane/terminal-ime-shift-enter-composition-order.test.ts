// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeShortcutGuard,
  writeTerminalShortcutInPtyOrder
} from './terminal-ime-shortcut-guard'

// Why: Shift+Enter reaches the PTY through the shortcut layer's direct write
// while composed text reaches it through xterm's onData, so only a test that
// interleaves both real channels can prove the bytes arrive in the typed order.

const SHIFT_ENTER_BYTES = '\x1b\r'
/** macOS delivers one Shift+Enter as a committing press and then the real one. */
const COMMITTING_ENTER = { key: 'Enter', isComposing: true }
const REAL_ENTER = { key: 'Enter', isComposing: false }

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function openTerminal(): {
  ptyWrites: string[]
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
  const ptyWrites: string[] = []
  terminal.onData((data) => ptyWrites.push(data))
  return { ptyWrites, terminal, textarea }
}

function startComposition(textarea: HTMLTextAreaElement, text: string): void {
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: text, bubbles: true }))
  textarea.value = text
}

/** Runs the shortcut layer over both keydowns, as keyboard-handlers does. */
function pressShiftEnter(ptyWrites: string[], textarea: HTMLTextAreaElement): void {
  const guard = createTerminalImeShortcutGuard()
  const sendShiftEnter = (): void => {
    ptyWrites.push(SHIFT_ENTER_BYTES)
  }
  const committing = guard.classifyKeydown(COMMITTING_ENTER)
  if (committing !== 'ime-owned') {
    writeTerminalShortcutInPtyOrder(committing, sendShiftEnter)
  }
  // The IME ends the composition as it consumes that press.
  textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  const real = guard.classifyKeydown(REAL_ENTER)
  if (real !== 'ime-owned') {
    writeTerminalShortcutInPtyOrder(real, sendShiftEnter)
  }
}

describe('Shift+Enter during an IME composition', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('sends the composed syllable once, before a single line break', async () => {
    const { ptyWrites, terminal, textarea } = openTerminal()
    startComposition(textarea, '녕')
    await nextEventLoop()

    pressShiftEnter(ptyWrites, textarea)
    await nextEventLoop()

    expect(ptyWrites).toEqual(['녕', SHIFT_ENTER_BYTES])
    terminal.dispose()
  })
})
