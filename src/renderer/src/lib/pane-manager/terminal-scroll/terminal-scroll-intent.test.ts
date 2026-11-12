import { describe, expect, it, vi } from 'vitest'
import {
  captureTerminalStructuralScrollIntent,
  getTerminalScrollIntentKind,
  restoreTerminalStructuralScrollIntent,
  syncTerminalScrollIntentFromViewport
} from './terminal-scroll-intent'

function createTerminal({ viewportY, baseY }: { viewportY: number; baseY: number }) {
  const terminal = {
    buffer: {
      active: {
        type: 'normal' as const,
        viewportY,
        baseY
      }
    },
    scrollToBottom: vi.fn(() => {
      terminal.buffer.active.viewportY = terminal.buffer.active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      terminal.buffer.active.viewportY = line
    })
  }
  return terminal
}

// WAKE-SCROLLBACK-SCROLL: the wake restore pins the person's line; that pin must not be for good.
describe('a pinned wake scroll', () => {
  it('stays put while new output arrives, and follows output again once back at the bottom', () => {
    const terminal = createTerminal({ viewportY: 12, baseY: 50 })
    // The restore put them on line 12 and recorded it.
    syncTerminalScrollIntentFromViewport(terminal, { allowBufferShrink: true })
    expect(getTerminalScrollIntentKind(terminal)).toBe('pinnedViewport')

    // New output while scrolled up: the view is not pulled down.
    const beforeOutput = captureTerminalStructuralScrollIntent(terminal)
    terminal.buffer.active.baseY = 60
    restoreTerminalStructuralScrollIntent(terminal, beforeOutput)
    expect(terminal.scrollToBottom).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBeLessThan(60)

    // They scroll back to the bottom: following output resumes.
    terminal.buffer.active.viewportY = 60
    syncTerminalScrollIntentFromViewport(terminal)
    expect(getTerminalScrollIntentKind(terminal)).toBe('followOutput')
    const atBottom = captureTerminalStructuralScrollIntent(terminal)
    terminal.buffer.active.baseY = 70
    restoreTerminalStructuralScrollIntent(terminal, atBottom)
    expect(terminal.buffer.active.viewportY).toBe(70)
  })
})
