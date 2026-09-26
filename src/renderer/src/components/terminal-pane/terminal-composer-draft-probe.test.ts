// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTerminalComposerDraftPresence } from './terminal-composer-draft-probe'

const openTerminals: Terminal[] = []
const FRAME = '─'.repeat(24)
/** Claude paints its placeholder to the right of the cursor, dim, then restores it. */
const CLAUDE_PLACEHOLDER = '\u001b7\u001b[2mTry “fix the failing test”\u001b[22m\u001b8'

let originalGetContext: PropertyDescriptor | undefined

beforeEach(() => {
  originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  // xterm measures text before it will open; happy-dom has no 2d context.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ measureText: () => ({ width: 10 }) })
  })
})

afterEach(() => {
  for (const terminal of openTerminals.splice(0)) {
    terminal.dispose()
  }
  if (originalGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
  }
  document.body.replaceChildren()
})

function openTerminal(): Terminal {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ cols: 80, rows: 12 })
  terminal.open(container)
  openTerminals.push(terminal)
  return terminal
}

function paint(terminal: Terminal, screen: string): Promise<void> {
  return new Promise((resolve) => terminal.write(`\u001b[2J\u001b[H${screen}`, resolve))
}

describe('readTerminalComposerDraftPresence', () => {
  it('sees a message typed into the agent composer', async () => {
    const terminal = openTerminal()
    await paint(terminal, `${FRAME}\r\n❯ ainda nao enviei isso`)

    expect(readTerminalComposerDraftPresence(terminal)).toBe(true)
  })

  it('does not count the composer placeholder as a message', async () => {
    const terminal = openTerminal()
    await paint(terminal, `${FRAME}\r\n❯ ${CLAUDE_PLACEHOLDER}`)

    expect(readTerminalComposerDraftPresence(terminal)).toBe(false)
  })

  it('does not count an empty composer', async () => {
    const terminal = openTerminal()
    await paint(terminal, `${FRAME}\r\n❯ `)

    expect(readTerminalComposerDraftPresence(terminal)).toBe(false)
  })

  it('answers false for a shell prompt that happens to use the same glyph', async () => {
    const terminal = openTerminal()
    await paint(terminal, 'saida do comando anterior\r\n❯ git status')

    expect(readTerminalComposerDraftPresence(terminal)).toBe(false)
  })

  it('says nothing when the screen has no cursor line to read', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    expect(
      readTerminalComposerDraftPresence({
        element: container,
        rows: 12,
        modes: { showCursor: true },
        buffer: {
          active: { baseY: 0, cursorX: 0, cursorY: 0, viewportY: 0, getLine: () => undefined }
        }
      })
    ).toBeNull()
  })

  it('says nothing for a pane that is not on screen', () => {
    const terminal = new Terminal({ cols: 80, rows: 12 })
    openTerminals.push(terminal)

    expect(readTerminalComposerDraftPresence(terminal)).toBeNull()
  })
})
