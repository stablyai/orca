import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  captureScrollViewportPosition,
  restoreScrollViewportPosition,
  type ScrollViewportPosition
} from './pane-scroll'

function createTerminal(args: {
  viewportY: number
  baseY: number
  cols: number
  rows: number
  type?: 'normal' | 'alternate'
}): Terminal {
  const active = {
    type: args.type ?? 'normal',
    viewportY: args.viewportY,
    baseY: args.baseY
  }
  return {
    cols: args.cols,
    rows: args.rows,
    buffer: { active },
    scrollToBottom: vi.fn(() => {
      active.viewportY = active.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      active.viewportY = line
    }),
    scrollLines: vi.fn((delta: number) => {
      active.viewportY = Math.max(0, Math.min(active.baseY, active.viewportY + delta))
    })
  } as unknown as Terminal
}

describe('scroll viewport position', () => {
  it('captures the numeric viewport position', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100, cols: 120, rows: 32 })

    expect(captureScrollViewportPosition(terminal)).toEqual({
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      cols: 120,
      rows: 32
    })
  })

  it('restores the same viewport line when the terminal grid did not reflow', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100, cols: 120, rows: 32 })
    const state: ScrollViewportPosition = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      cols: 120,
      rows: 32
    }

    restoreScrollViewportPosition(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(terminal.buffer.active.viewportY).toBe(42)
  })

  it('clamps the restored viewport line to the current buffer bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 30, cols: 120, rows: 32 })
    const state: ScrollViewportPosition = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      cols: 120,
      rows: 32
    }

    restoreScrollViewportPosition(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(30)
    expect(terminal.buffer.active.viewportY).toBe(30)
  })

  it('does not restore across normal and alternate buffers', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100, cols: 120, rows: 32 })
    const state: ScrollViewportPosition = {
      bufferType: 'alternate',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      cols: 120,
      rows: 32
    }

    restoreScrollViewportPosition(terminal, state)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(10)
  })

  it('scrolls to the current bottom when the pane was previously at bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 250, cols: 120, rows: 32 })
    const state: ScrollViewportPosition = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100,
      cols: 120,
      rows: 32
    }

    restoreScrollViewportPosition(terminal, state)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.viewportY).toBe(250)
  })

  it('does not numerically restore a non-bottom viewport after a grid reflow', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100, cols: 80, rows: 32 })
    const state: ScrollViewportPosition = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100,
      cols: 120,
      rows: 32
    }

    restoreScrollViewportPosition(terminal, state)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(10)
  })
})
