import { describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { captureScrollState, restoreScrollState } from './pane-scroll'
import type { ScrollState } from './pane-manager-types'

function createTerminal(args: {
  viewportY: number
  baseY: number
  type?: 'normal' | 'alternate'
}): Terminal {
  const active = {
    type: args.type ?? 'normal',
    viewportY: args.viewportY,
    baseY: args.baseY
  }
  return {
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

describe('scroll state', () => {
  it('captures the numeric viewport position', () => {
    const terminal = createTerminal({ viewportY: 42, baseY: 100 })

    expect(captureScrollState(terminal)).toEqual({
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    })
  })

  it('restores the captured viewport line', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(42)
    expect(terminal.buffer.active.viewportY).toBe(42)
  })

  it('clamps the restored viewport line to the current buffer bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 30 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).toHaveBeenCalledWith(30)
    expect(terminal.buffer.active.viewportY).toBe(30)
  })

  it('scrolls to the current bottom when the pane was previously at bottom', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 250 })
    const state: ScrollState = {
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 100,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal.buffer.active.viewportY).toBe(250)
  })

  it('does not restore across normal and alternate buffers', () => {
    const terminal = createTerminal({ viewportY: 10, baseY: 100 })
    const state: ScrollState = {
      bufferType: 'alternate',
      wasAtBottom: false,
      viewportY: 42,
      baseY: 100
    }

    restoreScrollState(terminal, state)

    expect(terminal.scrollToLine).not.toHaveBeenCalled()
    expect(terminal.buffer.active.viewportY).toBe(10)
  })
})
