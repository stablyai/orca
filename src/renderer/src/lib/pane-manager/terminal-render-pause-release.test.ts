import { describe, expect, it, vi } from 'vitest'
import {
  forceFullViewportPresent,
  forceRepaintThroughRenderPause,
  requestFullViewportPresent
} from './terminal-render-pause-release'

type FakeRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  _charSizeService?: { width?: number; height?: number }
  refreshRows?: ReturnType<typeof vi.fn>
  _renderer?: {
    value?: {
      clear?: ReturnType<typeof vi.fn>
      renderRows?: ReturnType<typeof vi.fn>
      _isAttached?: boolean
    }
  }
}

function createTerminal(options: {
  rows?: number
  renderService?: FakeRenderService | null
  withoutCore?: boolean
  synchronizedOutput?: boolean
  screenConnected?: boolean
}): unknown {
  const {
    rows = 24,
    renderService,
    withoutCore,
    synchronizedOutput,
    screenConnected = true
  } = options
  if (withoutCore) {
    return { rows }
  }
  return {
    rows,
    _core: {
      screenElement: { isConnected: screenConnected },
      _renderService: renderService ?? null,
      coreService: { decPrivateModes: { synchronizedOutput: synchronizedOutput === true } }
    }
  }
}

function createUnattachedWebglService(
  overrides: Partial<FakeRenderService> = {}
): FakeRenderService {
  return {
    _isPaused: true,
    _needsFullRefresh: true,
    _charSizeService: { width: 8, height: 16 },
    refreshRows: vi.fn(),
    _renderer: { value: { renderRows: vi.fn(), _isAttached: false } },
    ...overrides
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

describe('forceFullViewportPresent', () => {
  it('fails closed when xterm internals are unavailable', () => {
    expect(forceFullViewportPresent(null)).toBe(false)
  })

  it('leaves an unpaused, unsynchronized terminal to the normal refresh path', () => {
    // A forced sync renderRows on first splash paints before cell metrics
    // settle and shows a 1px black gutter under the TUI composer.
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const terminal = createTerminal({
      rows: 24,
      renderService: {
        _isPaused: false,
        _needsFullRefresh: false,
        refreshRows,
        _renderer: { value: { renderRows } }
      }
    })

    expect(forceFullViewportPresent(terminal)).toBe(false)
    expect(renderRows).not.toHaveBeenCalled()
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('paints through the renderer so DEC 2026 cannot swallow the reveal present', () => {
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const renderService = {
      _isPaused: false,
      _needsFullRefresh: false,
      refreshRows,
      _renderer: { value: { renderRows } }
    }
    const terminal = createTerminal({
      rows: 24,
      renderService,
      synchronizedOutput: true
    })

    expect(forceFullViewportPresent(terminal)).toBe(true)
    expect(renderRows).toHaveBeenCalledWith(0, 23)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('uses RenderService refreshRows when paused without DEC 2026, matching production splash', () => {
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const renderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows,
      _renderer: { value: { renderRows } }
    }
    const terminal = createTerminal({ rows: 24, renderService })

    expect(forceFullViewportPresent(terminal)).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderService._isPaused).toBe(false)
  })

  it('leaves pause cleared when the forced render throws so callers can refresh()', () => {
    const renderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows: vi.fn(() => {
        throw new Error('terminal disposed')
      }),
      _renderer: { value: { renderRows: vi.fn() } }
    }
    const terminal = createTerminal({ rows: 24, renderService })

    expect(forceFullViewportPresent(terminal)).toBe(false)
    expect(renderService._isPaused).toBe(false)
    // Why true: nothing painted, so xterm must keep owing the full repaint. Only
    // _isPaused has to stay cleared for the caller's refresh() fallback to run.
    expect(renderService._needsFullRefresh).toBe(true)
  })
})

describe('requestFullViewportPresent', () => {
  it('fails closed when xterm internals are unavailable', () => {
    expect(requestFullViewportPresent(null)).toBe(false)
  })

  it('leaves a normal visible terminal on the debounced refresh path', () => {
    const refreshRows = vi.fn()
    const terminal = createTerminal({
      renderService: { _isPaused: false, refreshRows }
    })

    expect(requestFullViewportPresent(terminal)).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('routes synchronized output through RenderService instead of the renderer', () => {
    const refreshRows = vi.fn()
    const renderRows = vi.fn()
    const terminal = createTerminal({
      rows: 24,
      synchronizedOutput: true,
      renderService: {
        _isPaused: false,
        refreshRows,
        _renderer: { value: { renderRows } }
      }
    })

    expect(requestFullViewportPresent(terminal)).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(renderRows).not.toHaveBeenCalled()
  })

  it('releases observer pause before requesting the synchronized frame', () => {
    const refreshRows = vi.fn()
    const renderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows
    }
    const terminal = createTerminal({ rows: 30, renderService, synchronizedOutput: true })

    expect(requestFullViewportPresent(terminal)).toBe(true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
    expect(refreshRows).toHaveBeenCalledWith(0, 29, true)
  })
})

describe("xterm's owed full repaint", () => {
  it('keeps the latch when an unattached renderer has no measured screen to attach to', () => {
    const renderService = createUnattachedWebglService()
    const terminal = createTerminal({ rows: 24, renderService, screenConnected: false })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(true)
    // The drive still runs: it is the cheapest way to let the renderer attach.
    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('keeps the latch when cell metrics are not measured yet', () => {
    const renderService = createUnattachedWebglService({
      _charSizeService: { width: 0, height: 0 }
    })
    const terminal = createTerminal({ rows: 24, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(false)
    expect(renderService._needsFullRefresh).toBe(true)
  })

  it('spends the latch once the unattached renderer can attach on this frame', () => {
    const renderService = createUnattachedWebglService()
    const terminal = createTerminal({ rows: 24, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('spends the latch for a DOM renderer, which has no attach gate', () => {
    const renderService: FakeRenderService = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows: vi.fn(),
      _renderer: { value: { renderRows: vi.fn() } }
    }
    const terminal = createTerminal({ rows: 24, renderService })

    expect(forceRepaintThroughRenderPause(terminal)).toBe(true)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('reports an unpainted request as not presented so the caller still refreshes', () => {
    const renderService = createUnattachedWebglService()
    const terminal = createTerminal({ rows: 24, renderService, screenConnected: false })

    expect(requestFullViewportPresent(terminal)).toBe(false)
    expect(renderService._needsFullRefresh).toBe(true)
  })

  it('keeps the latch on the DEC 2026 path, the one present that bypasses refreshRows', () => {
    const renderRows = vi.fn()
    const renderService = createUnattachedWebglService({
      _renderer: { value: { renderRows, _isAttached: false } }
    })
    const terminal = createTerminal({
      rows: 24,
      renderService,
      synchronizedOutput: true,
      screenConnected: false
    })

    expect(forceFullViewportPresent(terminal)).toBe(false)
    expect(renderRows).toHaveBeenCalledWith(0, 23)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(true)
  })

  it('reports an unpainted forced present as not presented', () => {
    const renderService = createUnattachedWebglService()
    const terminal = createTerminal({ rows: 24, renderService, screenConnected: false })

    expect(forceFullViewportPresent(terminal)).toBe(false)
    expect(renderService._needsFullRefresh).toBe(true)
  })
})
