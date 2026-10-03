// @vitest-environment happy-dom

import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

const openTerminals: Terminal[] = []

function openTerminal(inGrid: boolean): { terminal: Terminal; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 40, rows: 8, imePreeditInGrid: inGrid })
  terminal.open(container)
  openTerminals.push(terminal)
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

function screenRectReads(container: HTMLElement): ReturnType<typeof vi.fn> {
  const screen = container.querySelector<HTMLElement>('.xterm-screen')!
  const reads = vi.fn(() => new DOMRect(0, 0, 320, 136))
  screen.getBoundingClientRect = reads
  return reads
}

describe('installTerminalImeCandidateAnchor with in-grid preedit', () => {
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

  it('leaves the ordinary cursor to xterm without measuring the screen', async () => {
    const { terminal, container } = openTerminal(true)
    await write(terminal, '$ ls')
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '한')
    await settle()

    expect(reads).not.toHaveBeenCalled()
    expect(renderedRow(container, 0)).toBe('$ ls한')
  })

  it('draws the preedit on the relocated input row when the cursor waits on a blank row', async () => {
    const { terminal, container } = openTerminal(true)
    await write(terminal, 'Cursor Agent\r\n\r\n→ \x1b[6;1H')
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '한')
    await settle()

    expect(renderedRow(container, 2)).toBe('→ 한')
    expect(renderedRow(container, 5)).toBe('')
  })

  it('follows the path the open composition started on when the option flips mid-way', async () => {
    const { terminal, container } = openTerminal(true)
    await write(terminal, 'Cursor Agent\r\n\r\n→ \x1b[6;1H')
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '하')
    terminal.options.imePreeditInGrid = false
    const update = new CompositionEvent('compositionupdate', { bubbles: true })
    Object.defineProperty(update, 'data', { value: '한' })
    terminal.textarea!.value = '한'
    terminal.textarea!.dispatchEvent(update)
    await settle()

    expect(reads).not.toHaveBeenCalled()
    expect(renderedRow(container, 2)).toBe('→ 한')
  })

  it('keeps positioning the textarea itself on the overlay path', async () => {
    const { terminal, container } = openTerminal(false)
    await write(terminal, '$ ls')
    const reads = screenRectReads(container)
    installTerminalImeCandidateAnchor(terminal)
    compose(terminal, '한')

    expect(reads).toHaveBeenCalled()
    expect(terminal.textarea!.style.left).toBe('32px')
  })
})
