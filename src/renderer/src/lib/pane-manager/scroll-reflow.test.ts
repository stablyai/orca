import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { findLineByContent } from './pane-tree-ops'

/**
 * These tests verify what xterm.js actually does to viewportY (ydisp)
 * during terminal.resize() when column count changes cause line reflow.
 * Understanding this behavior is critical for preserving scroll position
 * when splitting terminal panes (which narrows the terminal).
 */

function writeSync(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function createTerminalWithContentAsync(
  cols: number,
  rows: number,
  scrollback: number,
  lineCount: number
): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  // headless terminal doesn't need open()
  for (let i = 0; i < lineCount; i++) {
    const line = `L${String(i).padStart(3, '0')}${'x'.repeat(cols - 4)}`
    await writeSync(term, `${line}\r\n`)
  }
  return term
}

describe('xterm.js scroll position during reflow', () => {
  it('reports buffer state correctly', async () => {
    const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
    const buf = term.buffer.active
    // 100 lines of content, 24 visible rows
    expect(buf.baseY).toBeGreaterThan(0)
    // By default after writing, terminal should be at bottom
    expect(buf.viewportY).toBe(buf.baseY)
    term.dispose()
  })

  it('scrollToLine sets viewportY', async () => {
    const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
    term.scrollToLine(10)
    expect(term.buffer.active.viewportY).toBe(10)
    term.dispose()
  })

  describe('resize from wider to narrower (split scenario)', () => {
    it('when at bottom: resize adjusts viewportY to stay at bottom', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      expect(buf.viewportY).toBe(buf.baseY)
      const oldBaseY = buf.baseY

      // Simulate split: narrow from 80 to 40 cols
      term.resize(40, 24)

      // After narrowing, lines wrap → more total lines → baseY increases
      expect(buf.baseY).toBeGreaterThanOrEqual(oldBaseY)
      // Does xterm keep us at the bottom?
      console.log(
        `[at-bottom] old baseY=${oldBaseY}, new baseY=${buf.baseY}, ` +
          `viewportY=${buf.viewportY}, at-bottom=${buf.viewportY >= buf.baseY}`
      )

      term.dispose()
    })

    it('when scrolled up: captures how xterm adjusts viewportY during reflow', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      // Scroll to line 30
      term.scrollToLine(30)
      expect(buf.viewportY).toBe(30)

      const oldViewportY = buf.viewportY
      const oldBaseY = buf.baseY

      // Simulate split: narrow from 80 to 40 cols
      term.resize(40, 24)

      console.log(
        `[scrolled-up] old viewportY=${oldViewportY}, old baseY=${oldBaseY}, ` +
          `new viewportY=${buf.viewportY}, new baseY=${buf.baseY}`
      )

      term.dispose()
    })

    it('when scrolled up: does scrollToLine before resize help?', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      // Scroll to line 30
      term.scrollToLine(30)
      expect(buf.viewportY).toBe(30)

      const savedViewportY = buf.viewportY
      const oldBaseY = buf.baseY

      // Simulate browser clobbering scroll to 0
      term.scrollToLine(0)
      expect(buf.viewportY).toBe(0)

      // Strategy A: restore scrollToLine BEFORE resize
      term.scrollToLine(savedViewportY)
      expect(buf.viewportY).toBe(savedViewportY)

      term.resize(40, 24)

      console.log(
        `[strategy-A: restore-before-resize] saved=${savedViewportY}, ` +
          `old baseY=${oldBaseY}, new viewportY=${buf.viewportY}, new baseY=${buf.baseY}`
      )

      term.dispose()
    })

    it('when scrolled up: does scrollToLine after resize work?', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      // Scroll to line 30
      term.scrollToLine(30)
      const savedViewportY = buf.viewportY
      const oldBaseY = buf.baseY

      // Simulate browser clobbering scroll to 0
      term.scrollToLine(0)

      // Strategy B: resize first (from clobbered state), then restore
      term.resize(40, 24)
      const postResizeViewportY = buf.viewportY
      const newBaseY = buf.baseY

      // Now try to restore with the old viewportY
      term.scrollToLine(savedViewportY)

      console.log(
        `[strategy-B: restore-after-resize] saved=${savedViewportY}, ` +
          `old baseY=${oldBaseY}, post-resize viewportY=${postResizeViewportY}, ` +
          `new baseY=${newBaseY}, final viewportY=${buf.viewportY}`
      )

      term.dispose()
    })

    it('ratio-based restoration after resize', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      term.scrollToLine(30)
      const savedViewportY = buf.viewportY
      const oldBaseY = buf.baseY
      const ratio = oldBaseY > 0 ? savedViewportY / oldBaseY : 0

      // Simulate browser clobbering scroll to 0
      term.scrollToLine(0)

      // Resize (from clobbered state)
      term.resize(40, 24)
      const newBaseY = buf.baseY

      // Strategy C: restore using ratio
      const targetLine = Math.round(ratio * newBaseY)
      term.scrollToLine(targetLine)

      console.log(
        `[strategy-C: ratio] saved=${savedViewportY}, old baseY=${oldBaseY}, ` +
          `ratio=${ratio.toFixed(3)}, new baseY=${newBaseY}, ` +
          `target=${targetLine}, final viewportY=${buf.viewportY}`
      )

      term.dispose()
    })

    it('getline-based: find first visible line content and match after reflow', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      term.scrollToLine(30)
      const savedViewportY = buf.viewportY

      // Capture the text of the first visible line
      const firstVisibleLine = buf.getLine(savedViewportY)?.translateToString(true) ?? ''
      const firstVisiblePrefix = firstVisibleLine.substring(0, 10)

      // Simulate browser clobbering scroll to 0
      term.scrollToLine(0)

      // Resize (from clobbered state)
      term.resize(40, 24)
      const newBaseY = buf.baseY

      // Strategy D: scan for the line with matching content
      let matchLine = -1
      for (let i = 0; i <= newBaseY + 24; i++) {
        const line = buf.getLine(i)?.translateToString(true) ?? ''
        if (line.startsWith(firstVisiblePrefix)) {
          matchLine = i
          break
        }
      }

      if (matchLine >= 0) {
        term.scrollToLine(matchLine)
      }

      console.log(
        `[strategy-D: content-match] looking for "${firstVisiblePrefix}", ` +
          `found at line ${matchLine}, viewportY=${buf.viewportY}, ` +
          `saved was ${savedViewportY}, new baseY=${newBaseY}`
      )

      term.dispose()
    })

    it('distance-from-bottom preservation', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      term.scrollToLine(30)
      const savedViewportY = buf.viewportY
      const oldBaseY = buf.baseY
      const distFromBottom = oldBaseY - savedViewportY

      // Simulate browser clobbering scroll to 0
      term.scrollToLine(0)

      // Resize (from clobbered state)
      term.resize(40, 24)
      const newBaseY = buf.baseY

      // Strategy E: preserve distance from bottom
      const targetLine = Math.max(0, newBaseY - distFromBottom)
      term.scrollToLine(targetLine)

      console.log(
        `[strategy-E: dist-from-bottom] saved=${savedViewportY}, ` +
          `old baseY=${oldBaseY}, distFromBottom=${distFromBottom}, ` +
          `new baseY=${newBaseY}, target=${targetLine}, ` +
          `final viewportY=${buf.viewportY}`
      )

      term.dispose()
    })
  })

  describe('reference: what does undisturbed resize do?', () => {
    it('resize without any scroll clobbering (ideal reference)', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      term.scrollToLine(30)
      const savedViewportY = buf.viewportY
      const oldBaseY = buf.baseY

      // DON'T clobber scroll — just resize directly
      term.resize(40, 24)

      console.log(
        `[reference: undisturbed] saved=${savedViewportY}, old baseY=${oldBaseY}, ` +
          `new viewportY=${buf.viewportY}, new baseY=${buf.baseY}`
      )

      // This is the gold standard — what xterm does natively
      term.dispose()
    })
  })

  describe('findLineByContent after reflow', () => {
    it('finds the correct line after narrowing', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 100)
      const buf = term.buffer.active

      term.scrollToLine(30)
      const firstVisibleContent = buf.getLine(30)?.translateToString(true)?.trimEnd() ?? ''

      term.resize(40, 24)

      // findLineByContent should locate the same content after reflow
      const target = findLineByContent(term as unknown as XtermTerminal, firstVisibleContent)
      expect(target).toBeGreaterThan(0)

      // After scrolling to target, the first visible line should contain
      // the same prefix as before the reflow
      term.scrollToLine(target)
      const afterContent = buf.getLine(target)?.translateToString(true)?.trimEnd() ?? ''
      expect(afterContent.startsWith(firstVisibleContent.substring(0, 10))).toBe(true)

      term.dispose()
    })

    it('returns -1 for empty content', async () => {
      const term = await createTerminalWithContentAsync(80, 24, 1000, 10)
      const target = findLineByContent(term as unknown as XtermTerminal, '')
      expect(target).toBe(-1)
      term.dispose()
    })
  })
})
