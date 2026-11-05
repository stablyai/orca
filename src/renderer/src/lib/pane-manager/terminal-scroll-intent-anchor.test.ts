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
})
