// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bindTerminalScrollIntentKey,
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

  it('keeps a keyed remount on the pinned content after trimming', async () => {
    const first = createTerminal()
    bindTerminalScrollIntentKey(first, 'anchor-keyed-remount')
    await writeLines(first, 0, 100)
    first.scrollToLine(20)
    markTerminalPinnedViewport(first)
    const pinnedContent = topVisibleLine(first)
    await writeLines(first, 100, 12)
    syncTerminalScrollIntentFromViewport(first)

    const replacement = createTerminal()
    bindTerminalScrollIntentKey(replacement, 'anchor-keyed-remount')
    await writeLines(replacement, 0, 112)
    enforceTerminalCurrentScrollIntent(replacement)

    expect(topVisibleLine(replacement)).toBe(pinnedContent)
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

  it('re-anchors when the user returns to the stale recorded line after trimming', async () => {
    const terminal = createTerminal()
    await writeLines(terminal, 0, 100)
    terminal.scrollToLine(20)
    markTerminalPinnedViewport(terminal)
    await writeLines(terminal, 100, 9)
    expect(terminal.buffer.active.viewportY).toBe(11)

    terminal.scrollToLine(20)
    syncTerminalScrollIntentFromViewport(terminal)
    const pinnedContent = topVisibleLine(terminal)
    terminal.scrollToBottom()
    enforceTerminalCurrentScrollIntent(terminal)

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
