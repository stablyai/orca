// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeComposerPlaceholderMask } from './terminal-ime-composer-placeholder-mask'

const CODEX_FOOTER = '\r\n\r\n\x1b[2mgpt-5.6 · ~/repo\x1b[22m\x1b8'
const openTerminals: Terminal[] = []

function openGridTerminal(): { terminal: Terminal; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 12, imePreeditInGrid: true })
  terminal.open(container)
  openTerminals.push(terminal)
  installTerminalImeComposerPlaceholderMask(terminal)
  return { terminal, container }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

function compose(terminal: Terminal, text: string): void {
  const textarea = terminal.textarea!
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  textarea.value = text
  const update = new CompositionEvent('compositionupdate', { bubbles: true })
  Object.defineProperty(update, 'data', { value: text })
  textarea.dispatchEvent(update)
}

function renderedRow(container: HTMLElement, row: number): string {
  const element = container.querySelectorAll('.xterm-rows > div')[row]
  return (element?.textContent ?? '').replace(/ /g, ' ').trimEnd()
}

describe('terminal IME composer placeholder mask with in-grid preedit', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      const context: CanvasRenderingContext2D = Object.create(null)
      context.measureText = () => Object.assign(Object.create(null), { width: 10 })
      return context
    })
  })

  afterEach(() => {
    while (openTerminals.length > 0) {
      openTerminals.pop()?.dispose()
    }
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('replaces an owned placeholder with the preedit instead of pushing it right', async () => {
    const { terminal, container } = openGridTerminal()
    await write(
      terminal,
      `\x1b[2J\x1b[H\x1b[1m›\x1b[22m \x1b7\x1b[2mAsk Codex to do anything\x1b[22m${CODEX_FOOTER}`
    )
    compose(terminal, '아')
    await settle()

    expect(renderedRow(container, 0)).toBe('› 아')
  })

  it('keeps typed draft text after the cursor visible and pushed right', async () => {
    const { terminal, container } = openGridTerminal()
    await write(terminal, `\x1b[2J\x1b[H\x1b[1m›\x1b[22m review\x1b7 this${CODEX_FOOTER}`)
    compose(terminal, '아')
    await settle()

    expect(renderedRow(container, 0)).toBe('› review아 this')
  })
})
