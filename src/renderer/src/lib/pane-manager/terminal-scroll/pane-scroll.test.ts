import { describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { captureScrollState } from './pane-scroll-snapshot'
import {
  cancelDeferredScrollRestore,
  cancelPendingFitScrollRestore,
  resumePendingFitScrollRestoreAfterFit,
  restoreScrollState,
  restoreScrollStateAfterFit
} from './pane-scroll'

function writeHeadless(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function findBufferLineContaining(terminal: HeadlessTerminal, text: string): number {
  for (let lineY = 0; lineY < terminal.buffer.active.length; lineY += 1) {
    if (terminal.buffer.active.getLine(lineY)?.translateToString(true).includes(text)) {
      return lineY
    }
  }
  return -1
}

function makeHeadlessRestorable(terminal: HeadlessTerminal): Terminal {
  Object.defineProperty(terminal, 'element', { configurable: true, value: {} })
  return terminal as unknown as Terminal
}

describe('scroll state', () => {
  // WAKE-SCROLLBACK-SCROLL: a remount's first fit captures "at bottom" while the pane can't render
  // yet and waits; the person's place, set after it, must not be undone when that restore resumes.
  async function heldBottomRestore() {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const headless = new HeadlessTerminal({ cols: 20, rows: 5, scrollback: 100 })
    await writeHeadless(headless, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\r\n'))
    const terminal = makeHeadlessRestorable(headless)
    const atBottom = captureScrollState(terminal)
    // Not renderable yet: the restore retries on later frames and is kept for the next fit.
    Object.defineProperty(terminal, 'element', { configurable: true, value: undefined })
    restoreScrollStateAfterFit(terminal, atBottom, {
      onRestored: () => {},
      shouldRestore: () => true
    })
    Object.defineProperty(terminal, 'element', { configurable: true, value: {} })
    // The wake restore puts the person back on their line.
    headless.scrollToLine(12)
    return { headless, terminal, frames }
  }

  it('without cancelling, a held at-bottom fit restore undoes a scroll set after it', async () => {
    const { headless, frames } = await heldBottomRestore()
    try {
      frames.shift()?.(0)
      expect(headless.buffer.active.viewportY).toBe(headless.buffer.active.baseY)
    } finally {
      headless.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('cancelling pending restores keeps a deliberately set scroll through later frames and fits', async () => {
    const { headless, terminal, frames } = await heldBottomRestore()
    try {
      cancelDeferredScrollRestore(terminal)
      cancelPendingFitScrollRestore(terminal)
      while (frames.length > 0) {
        frames.shift()?.(0)
      }
      expect(resumePendingFitScrollRestoreAfterFit(terminal)).toBe(false)
      expect(headless.buffer.active.viewportY).toBe(12)
    } finally {
      headless.dispose()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    {
      fromCols: 10,
      toCols: 20,
      pinnedText: 'abcdefghij',
      expectedTop: 'ABCDEFGHIJabcdefghij'
    },
    { fromCols: 20, toCols: 7, pinnedText: 'KLMNOPQRSTuvwxyz', expectedTop: 'efghijK' }
  ])(
    'restores the same logical cells through real xterm reflow ($fromCols->$toCols)',
    async ({ fromCols, toCols, pinnedText, expectedTop }) => {
      const headless = new HeadlessTerminal({
        cols: fromCols,
        rows: 5,
        scrollback: 1000,
        allowProposedApi: true
      })
      try {
        await writeHeadless(headless, 'prefix\r\n')
        await writeHeadless(headless, 'ABCDEFGHIJabcdefghijKLMNOPQRSTuvwxyz\r\n')
        for (let index = 0; index < 10; index += 1) {
          await writeHeadless(headless, `tail-${index}\r\n`)
        }
        const pinnedLine = findBufferLineContaining(headless, pinnedText)
        expect(pinnedLine).toBeGreaterThan(0)
        headless.scrollToLine(pinnedLine)
        const terminal = makeHeadlessRestorable(headless)
        const state = captureScrollState(terminal)

        headless.resize(toCols, 5)
        expect(state.firstVisibleLogicalLineMarker?.isDisposed).toBe(false)
        expect(restoreScrollState(terminal, state)).toBe(true)

        expect(
          headless.buffer.active.getLine(headless.buffer.active.viewportY)?.translateToString(true)
        ).toBe(expectedTop)
      } finally {
        headless.dispose()
      }
    }
  )
})
