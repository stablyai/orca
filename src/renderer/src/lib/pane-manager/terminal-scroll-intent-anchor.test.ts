// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enforceTerminalCurrentScrollIntent,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'

const ROWS = 10
const SCROLLBACK = 50
const terminals: Terminal[] = []

function createTerminal(): Terminal {
  const terminal = new Terminal({ cols: 20, rows: ROWS, scrollback: SCROLLBACK })
  terminals.push(terminal)
  return terminal
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

async function writeLines(terminal: Terminal, from: number, count: number): Promise<void> {
  let data = ''
  for (let i = from; i < from + count; i += 1) {
    data += `line-${i}\r\n`
  }
  await write(terminal, data)
}

function topVisibleLine(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  return buffer.getLine(buffer.viewportY)?.translateToString(true) ?? ''
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

describe('pinned scroll intent anchoring', () => {
  it('restores the pinned content after scrollback trimming renumbers lines', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(20)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 100, 12)
    // xterm keeps a user-scrolled viewport on the same content while trimming.
    expect(terminal.buffer.active.viewportY).toBe(8)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)

    // A mouse report or typed key snaps xterm to the bottom before Orca restores.
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(8)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('restores the same absolute line when nothing was trimmed', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 30)
    terminal.scrollToLine(5)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 30, 4)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(5)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('falls back to the recorded line once the pinned line is trimmed away', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(3)
    markTerminalPinnedViewport(terminal)

    await writeLines(terminal, 100, 20)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(3)
  })

  it('re-anchors when the user moves the pin', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(30)
    markTerminalPinnedViewport(terminal)
    terminal.scrollToLine(25)
    syncTerminalScrollIntentFromViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await writeLines(terminal, 100, 5)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(20)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('restores the pinned content when a smaller scrollback shrinks baseY', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(20)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    terminal.options.scrollback = 40
    expect(terminal.buffer.active.baseY).toBe(40)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(terminal.buffer.active.viewportY).toBe(10)
    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('falls back to the recorded coordinates after the scrollback is cleared for a replay', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(20)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    await write(terminal, '\x1b[2J\x1b[3J\x1b[H')
    await writeLines(terminal, 40, 60)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })
})

describe('pinned scroll intent anchoring across reflow', () => {
  function createWrappedTerminal(cols: number): Promise<Terminal> {
    const terminal = new Terminal({ cols, rows: ROWS, scrollback: 500 })
    terminals.push(terminal)
    let data = ''
    for (let i = 0; i < 60; i += 1) {
      // Every third line is long enough to wrap at 20 columns.
      data += `L${String(i).padStart(2, '0')}-${'x'.repeat(i % 3 === 0 ? 30 : 5)}\r\n`
    }
    return write(terminal, data).then(() => terminal)
  }

  function logicalLineStart(terminal: Terminal, lineY: number): string {
    const buffer = terminal.buffer.active
    let y = lineY
    while (y > 0 && buffer.getLine(y)?.isWrapped) {
      y -= 1
    }
    return buffer.getLine(y)?.translateToString(true).slice(0, 4) ?? ''
  }

  it('keeps an unwrapped pinned line when widening renumbers rows', async () => {
    const terminal = await createWrappedTerminal(20)
    terminal.scrollToLine(10)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    terminal.resize(40, ROWS)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })

  it('keeps the logical line when widening removes the pinned continuation row', async () => {
    const terminal = await createWrappedTerminal(20)
    terminal.scrollToLine(25)
    expect(terminal.buffer.active.getLine(25)?.isWrapped).toBe(true)
    markTerminalPinnedViewport(terminal)
    const pinnedLogicalLine = logicalLineStart(terminal, 25)

    terminal.resize(40, ROWS)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(topVisibleLine(terminal).slice(0, 4)).toBe(pinnedLogicalLine)
  })

  it('keeps a pin near the bottom when narrowing grows baseY', async () => {
    const terminal = await createWrappedTerminal(40)
    terminal.scrollToLine(40)
    markTerminalPinnedViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)

    terminal.resize(20, ROWS)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

    expect(topVisibleLine(terminal)).toBe(pinnedContent)
  })
})
