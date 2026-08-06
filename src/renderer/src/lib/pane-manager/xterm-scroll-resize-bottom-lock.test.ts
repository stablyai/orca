import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { Terminal as RendererTerminal } from '@xterm/xterm'
import type { ManagedPane } from './pane-manager-types'
import { safeFit } from './pane-fit'
import { getTerminalScrollIntentKind } from './terminal-scroll-intent'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function findBufferLineContaining(term: Terminal, text: string): number {
  const buf = term.buffer.active
  for (let lineY = 0; lineY < buf.length; lineY += 1) {
    if (buf.getLine(lineY)?.translateToString(true).includes(text)) {
      return lineY
    }
  }
  return -1
}

function topOfViewportText(term: Terminal): string {
  const buf = term.buffer.active
  return buf.getLine(buf.viewportY)?.translateToString(true) ?? ''
}

function makeSafeFitPane(term: Terminal): {
  pane: ManagedPane
  setGrid: (cols: number, rows: number) => void
} {
  let proposed = { cols: term.cols, rows: term.rows }
  Object.defineProperty(term, 'element', { configurable: true, value: {} })
  const pane = {
    terminal: term as unknown as RendererTerminal,
    container: {
      dataset: {},
      getBoundingClientRect: () => ({ width: 1_320, height: 820 })
    },
    fitAddon: {
      proposeDimensions: () => proposed,
      fit: () => term.resize(proposed.cols, proposed.rows)
    },
    pendingSplitScrollState: null
  } as unknown as ManagedPane
  return {
    pane,
    setGrid: (cols, rows) => {
      proposed = { cols, rows }
    }
  }
}

describe('xterm scroll behavior through safe fit', () => {
  it('bottom-locks a pinned chat viewport through the product safe-fit path', async () => {
    const term = new Terminal({
      cols: 159,
      rows: 69,
      scrollback: 5000,
      allowProposedApi: true
    })

    try {
      for (let row = 0; row < 420; row += 1) {
        await write(
          term,
          `ROW${String(row).padStart(4, '0')} CODEX_CHAT_HISTORY_${'a'.repeat(36)} assistant response ${'x'.repeat(92)}\r\n`
        )
      }
      const pinMarker = 'ROW0249'
      const pinLineY = findBufferLineContaining(term, pinMarker)
      term.scrollToLine(pinLineY)
      expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY)
      expect(topOfViewportText(term)).toContain(pinMarker)

      const { pane, setGrid } = makeSafeFitPane(term)
      setGrid(159, 47)
      expect(safeFit(pane)).toBe(true)
      expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY)
      expect(topOfViewportText(term)).toContain(pinMarker)
      expect(getTerminalScrollIntentKind(pane.terminal)).toBe('pinnedViewport')

      setGrid(14, 47)
      expect(safeFit(pane)).toBe(true)
      expect(term.buffer.active.baseY).toBe(5000)
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
      expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')

      setGrid(84, 47)
      expect(safeFit(pane)).toBe(true)
      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    } finally {
      term.dispose()
    }
  })

  it('bottom-locks when reflow fills the scrollback cap', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 5,
      scrollback: 20,
      allowProposedApi: true
    })

    try {
      for (let row = 0; row < 30; row += 1) {
        await write(term, `ROW${String(row).padStart(4, '0')} ${'x'.repeat(60)}\r\n`)
      }
      const pinLineY = findBufferLineContaining(term, 'ROW0010')
      term.scrollToLine(pinLineY)
      expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY)

      const { pane, setGrid } = makeSafeFitPane(term)
      setGrid(8, 5)
      expect(safeFit(pane)).toBe(true)

      expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
      expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
    } finally {
      term.dispose()
    }
  })
})
