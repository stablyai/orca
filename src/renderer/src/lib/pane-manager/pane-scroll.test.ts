import { describe, expect, it, vi } from 'vitest'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { captureScrollState, restoreScrollState, restoreScrollStateAfterFit } from './pane-scroll'

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
  it('retries a fit restore when xterm leaves the viewport short of the target', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    const headless = new HeadlessTerminal({ cols: 20, rows: 5, scrollback: 100 })
    try {
      await writeHeadless(headless, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\r\n'))
      headless.scrollToLine(10)
      const terminal = makeHeadlessRestorable(headless)
      const state = captureScrollState(terminal)
      const marker = state.firstVisibleLineMarker
      headless.scrollToBottom()
      // xterm 6 clamps against stale scrollbar geometry until its queued viewport sync runs.
      vi.spyOn(terminal, 'scrollToLine').mockImplementationOnce(() => {})
      const onRestored = vi.fn()

      restoreScrollStateAfterFit(terminal, state, { onRestored, shouldRestore: () => true })
      expect(onRestored).not.toHaveBeenCalled()
      expect(marker?.isDisposed).toBe(false)

      frames.shift()?.(0)
      expect(headless.buffer.active.viewportY).toBe(10)
      expect(onRestored).toHaveBeenCalledOnce()
      expect(marker?.isDisposed).toBe(true)
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

  it('uses a logical marker for backend-only ConPTY compatibility', async () => {
    const headless = new HeadlessTerminal({
      cols: 10,
      rows: 5,
      scrollback: 1000,
      allowProposedApi: true,
      windowsPty: { backend: 'conpty' }
    })
    try {
      await writeHeadless(headless, 'prefix\r\n')
      await writeHeadless(headless, 'ABCDEFGHIJabcdefghijKLMNOPQRSTuvwxyz\r\n')
      for (let index = 0; index < 10; index += 1) {
        await writeHeadless(headless, `tail-${index}\r\n`)
      }
      const pinnedLine = findBufferLineContaining(headless, 'abcdefghij')
      headless.scrollToLine(pinnedLine)
      const terminal = makeHeadlessRestorable(headless)
      const state = captureScrollState(terminal)

      expect(state.firstVisibleLogicalLineMarker).toBeDefined()
      headless.resize(20, 5)
      expect(restoreScrollState(terminal, state)).toBe(true)
      expect(
        headless.buffer.active.getLine(headless.buffer.active.viewportY)?.translateToString(true)
      ).toBe('ABCDEFGHIJabcdefghij')
    } finally {
      headless.dispose()
    }
  })
})
