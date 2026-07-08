import { describe, expect, it, vi } from 'vitest'
import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'

type FakeRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: ReturnType<typeof vi.fn>
}

function createTerminal(options: {
  rows?: number
  renderService?: FakeRenderService | null
  withoutCore?: boolean
}): unknown {
  const { rows = 24, renderService, withoutCore } = options
  if (withoutCore) {
    return { rows }
  }
  return {
    rows,
    _core: { _renderService: renderService ?? null }
  }
}

describe('forceRepaintThroughRenderPause', () => {
  it('drives a synchronous full-viewport render and clears the pause latches when paused', () => {
    const refreshRows = vi.fn()
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows
    }
    const terminal = createTerminal({ rows: 30, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 29, true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('leaves the terminal untouched and returns false when not paused', () => {
    const refreshRows = vi.fn()
    const renderService: FakeRenderService = {
      _isPaused: false,
      _needsFullRefresh: false,
      refreshRows
    }
    const terminal = createTerminal({ renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('returns false when the render service internals are unavailable', () => {
    expect(forceRepaintThroughRenderPause(createTerminal({ withoutCore: true }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: null }))).toBe(false)
    expect(forceRepaintThroughRenderPause(createTerminal({ renderService: {} }))).toBe(false)
    expect(forceRepaintThroughRenderPause(null)).toBe(false)
  })

  it('returns false without rendering when the row count is invalid', () => {
    const refreshRows = vi.fn()
    const terminal = createTerminal({
      rows: 0,
      renderService: { _isPaused: true, refreshRows }
    })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('returns false when the forced render throws (disposed mid-frame)', () => {
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows: vi.fn(() => {
        throw new Error('terminal disposed')
      })
    }
    const terminal = createTerminal({ renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    // Latch is still cleared — the observer reasserts authority on its next
    // callback, and we must not leave a half-serviced full-refresh queued.
    expect(renderService._isPaused).toBe(false)
  })
})
