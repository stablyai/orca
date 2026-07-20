import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discardForegroundRenderSettle,
  writeForegroundTerminalChunk,
  type ForegroundTerminalOutputTarget
} from './pane-terminal-foreground-render-settle'

type TestTerminal = ForegroundTerminalOutputTarget & {
  _core: { refresh: ReturnType<typeof vi.fn> }
  write: ReturnType<typeof vi.fn>
}

function createTerminal(): TestTerminal {
  return {
    rows: 40,
    buffer: { active: { baseY: 0, cursorY: 10, viewportY: 0 } },
    _core: { refresh: vi.fn() },
    write: vi.fn((_data: string, callback?: () => void) => callback?.())
  }
}

describe('foreground terminal render settle', () => {
  const frameCallbacks: FrameRequestCallback[] = []

  afterEach(() => {
    frameCallbacks.length = 0
    vi.unstubAllGlobals()
  })

  function installAnimationFrames(): void {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  }

  it('parses every write immediately but refreshes at most once per frame', () => {
    installAnimationFrames()
    const terminal = createTerminal()

    for (let index = 0; index < 100; index += 1) {
      writeForegroundTerminalChunk(terminal, `frame ${index}`, { forceViewportRefresh: true })
    }

    expect(terminal.write).toHaveBeenCalledTimes(100)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
    expect(frameCallbacks).toHaveLength(1)

    frameCallbacks.shift()?.(0)
    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 39, true)
  })

  it('keeps a fixed frame cadence while output continues', () => {
    installAnimationFrames()
    const terminal = createTerminal()

    writeForegroundTerminalChunk(terminal, 'first', { forceViewportRefresh: true })
    expect(terminal._core.refresh).not.toHaveBeenCalled()
    frameCallbacks.shift()?.(0)
    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)

    writeForegroundTerminalChunk(terminal, 'second', { forceViewportRefresh: true })
    expect(frameCallbacks).toHaveLength(1)
    frameCallbacks.shift()?.(16)
    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
  })

  it('preserves a requested follow-up without duplicating the first frame', () => {
    installAnimationFrames()
    const terminal = createTerminal()

    writeForegroundTerminalChunk(terminal, 'first', {
      forceViewportRefresh: true,
      followupViewportRefresh: true
    })
    writeForegroundTerminalChunk(terminal, 'second', { forceViewportRefresh: true })

    expect(terminal._core.refresh).not.toHaveBeenCalled()
    expect(frameCallbacks).toHaveLength(1)
    frameCallbacks.shift()?.(0)
    expect(terminal._core.refresh).toHaveBeenCalledTimes(1)
    expect(frameCallbacks).toHaveLength(1)
    frameCallbacks.shift()?.(16)
    expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
  })

  it('refreshes the full viewport when output scrolls', () => {
    installAnimationFrames()
    const terminal = createTerminal()
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      if (terminal.buffer?.active) {
        terminal.buffer.active.baseY = 1
        terminal.buffer.active.cursorY = 39
        terminal.buffer.active.viewportY = 1
      }
      callback?.()
    })

    writeForegroundTerminalChunk(terminal, 'scrolled', { forceViewportRefresh: true })
    frameCallbacks.shift()?.(0)

    expect(terminal._core.refresh).toHaveBeenCalledWith(0, 39, true)
  })

  it('cancels a pending refresh when the terminal is discarded', () => {
    installAnimationFrames()
    const terminal = createTerminal()

    writeForegroundTerminalChunk(terminal, 'data', {
      forceViewportRefresh: true,
      followupViewportRefresh: true
    })
    discardForegroundRenderSettle(terminal)
    frameCallbacks.shift()?.(0)

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(terminal._core.refresh).not.toHaveBeenCalled()
  })
})
