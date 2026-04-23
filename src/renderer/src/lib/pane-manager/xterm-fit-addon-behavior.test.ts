import { describe, expect, it, vi } from 'vitest'
import { FitAddon } from '@xterm/addon-fit'

type MockTerminal = {
  cols: number
  rows: number
  buffer: {
    active: {
      viewportY: number
      baseY: number
    }
  }
  _core: {
    _renderService: {
      clear: ReturnType<typeof vi.fn>
    }
  }
  resize: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  scrollToBottom: ReturnType<typeof vi.fn>
}

function createMockTerminal({
  cols,
  rows,
  viewportY,
  baseY
}: {
  cols: number
  rows: number
  viewportY: number
  baseY: number
}): MockTerminal {
  return {
    cols,
    rows,
    buffer: {
      active: {
        viewportY,
        baseY
      }
    },
    _core: {
      _renderService: {
        clear: vi.fn()
      }
    },
    resize: vi.fn(),
    refresh: vi.fn(),
    scrollToBottom: vi.fn()
  }
}

describe('patched xterm FitAddon behavior', () => {
  it('avoids clear+refresh on true grid resizes', () => {
    const terminal = createMockTerminal({ cols: 120, rows: 32, viewportY: 20, baseY: 20 })
    const addon = new FitAddon()
    addon.activate(terminal as never)
    vi.spyOn(addon, 'proposeDimensions').mockReturnValue({ cols: 100, rows: 32 })

    addon.fit()

    expect(terminal.resize).toHaveBeenCalledWith(100, 32)
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(terminal._core._renderService.clear).not.toHaveBeenCalled()
    expect(terminal.refresh).not.toHaveBeenCalled()
  })

  it('still forces a repaint on same-grid pixel-only resizes', () => {
    const terminal = createMockTerminal({ cols: 120, rows: 32, viewportY: 10, baseY: 20 })
    const addon = new FitAddon()
    addon.activate(terminal as never)
    vi.spyOn(addon, 'proposeDimensions').mockReturnValue({ cols: 120, rows: 32 })

    addon.fit()

    expect(terminal.resize).not.toHaveBeenCalled()
    expect(terminal._core._renderService.clear).toHaveBeenCalledTimes(1)
    expect(terminal.refresh).toHaveBeenCalledWith(0, 31)
  })
})
