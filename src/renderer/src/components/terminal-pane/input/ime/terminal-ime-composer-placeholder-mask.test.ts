// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installTerminalImeComposerPlaceholderMask,
  TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS
} from './terminal-ime-composer-placeholder-mask'
import {
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

const CODEX_PLACEHOLDER = 'Ask Codex to do anything'
const openTerminals: Terminal[] = []

function nextEventLoop(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0))
}

type Rig = {
  compose: (preedit?: string) => void
  compositionView: HTMLElement
  disposeMask: () => void
  element: HTMLElement
  endComposition: (commit?: string) => Promise<void>
  textarea: HTMLTextAreaElement
  terminal: Terminal
  write: (data: string) => Promise<void>
  writeAwaitingRender: (data: string) => Promise<void>
}

function openTerminal(): Rig {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 12 })
  terminal.open(container)
  openTerminals.push(terminal)
  const element = terminal.element
  const textarea = terminal.textarea
  const compositionView = container.querySelector<HTMLElement>('.composition-view')
  if (!element || !textarea || !compositionView) {
    throw new Error('xterm did not create its terminal composition elements')
  }
  const mask = installTerminalImeComposerPlaceholderMask(terminal)
  const write = (data: string): Promise<void> =>
    new Promise((resolve) => terminal.write(data, resolve))
  const writeAwaitingRender = async (data: string): Promise<void> => {
    await write(data)
    await new Promise<void>((resolve) => {
      const rendered = terminal.onRender(() => {
        rendered.dispose()
        resolve()
      })
    })
  }
  const compose = (preedit = '아'): void => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    textarea.value = preedit
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: preedit })
    textarea.dispatchEvent(update)
  }
  const endComposition = async (commit = '아'): Promise<void> => {
    textarea.value = commit
    const end = new CompositionEvent('compositionend', { bubbles: true })
    Object.defineProperty(end, 'data', { value: commit })
    textarea.dispatchEvent(end)
    await nextEventLoop()
    await nextEventLoop()
  }
  return {
    compose,
    compositionView,
    disposeMask: () => mask.dispose(),
    element,
    endComposition,
    terminal,
    textarea,
    write,
    writeAwaitingRender
  }
}

function codexPlaceholderFrame(): string {
  return [
    '\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7',
    `\x1b[2m${CODEX_PLACEHOLDER}\x1b[22m`,
    '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
  ].join('')
}

function dispatchSession(rig: Rig, type: string, id: number): void {
  rig.element.dispatchEvent(
    new CustomEvent(type, {
      bubbles: true,
      detail: { id }
    })
  )
}

describe('terminal IME composer placeholder mask', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      measureText: () => ({ width: 10 })
    } as unknown as CanvasRenderingContext2D)
  })

  afterEach(async () => {
    await nextEventLoop()
    await nextEventLoop()
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('leaves non-placeholder Codex draft text untouched', async () => {
    const rig = openTerminal()
    await rig.write(
      [
        '\x1b[2J\x1b[H\x1b[1m›\x1b[22m review\x1b7 this',
        '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
      ].join('')
    )

    expect(rig.terminal.buffer.active.cursorX).toBe(8)
    expect(rig.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('› review this')
    rig.compose()

    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(false)
    expect(rig.compositionView.querySelector('.xterm-composition-remainder')?.textContent).toBe(
      ' this'
    )
  })

  it('drops a latched owner on blur even when no session end follows', async () => {
    const rig = openTerminal()
    await rig.write(codexPlaceholderFrame())
    // Blur the terminal element: textarea blur also ends the session and would hide a broken ownership listener.
    dispatchSession(rig, XTERM_COMPOSITION_SESSION_START_EVENT, 7)
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(true)

    rig.element.dispatchEvent(new FocusEvent('blur'))

    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(false)
    await rig.writeAwaitingRender(codexPlaceholderFrame())
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(false)
  })

  it('reclassifies a repaint only while composition is active', async () => {
    const rig = openTerminal()
    await rig.write(codexPlaceholderFrame())
    rig.compose()
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(true)

    const ordinaryDimOutput = 'Background task'
    await rig.writeAwaitingRender(
      `\x1b[K\x1b[2m${ordinaryDimOutput}\x1b[22m\x1b[${ordinaryDimOutput.length}D`
    )
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(false)

    await rig.writeAwaitingRender(
      `\x1b[K\x1b[2m${CODEX_PLACEHOLDER}\x1b[22m\x1b[${CODEX_PLACEHOLDER.length}D`
    )
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(true)
  })

  it('keeps the newest session owner when an older session ends first', async () => {
    const rig = openTerminal()
    await rig.write(codexPlaceholderFrame())

    dispatchSession(rig, XTERM_COMPOSITION_SESSION_START_EVENT, 1)
    dispatchSession(rig, XTERM_COMPOSITION_SESSION_START_EVENT, 2)
    dispatchSession(rig, XTERM_COMPOSITION_SESSION_END_EVENT, 1)
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(true)

    dispatchSession(rig, XTERM_COMPOSITION_SESSION_END_EVENT, 2)
    expect(rig.element.classList.contains(TERMINAL_IME_COMPOSER_PLACEHOLDER_CLASS)).toBe(false)
  })
})
