import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forEachLivePaneForDesyncSentinel = vi.fn()
const resetAndRefreshAllTerminalWebglAtlases = vi.fn()
vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  forEachLivePaneForDesyncSentinel: (
    ...args: Parameters<typeof forEachLivePaneForDesyncSentinel>
  ) => forEachLivePaneForDesyncSentinel(...args),
  resetAndRefreshAllTerminalWebglAtlases: () => resetAndRefreshAllTerminalWebglAtlases()
}))

const recordTerminalWebglDiagnostic = vi.fn()
const documentAddEventListener = vi.fn()
const documentRemoveEventListener = vi.fn()
class FakeNode {}
const writeTerminalRenderDesyncEvidence = vi.fn().mockResolvedValue({
  directory: '/evidence/capture',
  pngPath: '/evidence/capture/corrupt.png',
  metadataPath: '/evidence/capture/corrupt.json'
})
vi.mock('../../../../shared/terminal-webgl-diagnostics', () => ({
  recordTerminalWebglDiagnostic: (...args: Parameters<typeof recordTerminalWebglDiagnostic>) =>
    recordTerminalWebglDiagnostic(...args)
}))

import {
  getRenderDesyncEvidence,
  maybeStartTerminalRenderDesyncSentinel,
  RENDER_DESYNC_SENTINEL_FLAG,
  sampleRenderDesyncOnce,
  stopTerminalRenderDesyncSentinelForTesting
} from './terminal-render-desync-sentinel'

function fakePane(overrides: { paused?: boolean } = {}) {
  const refreshRows = vi.fn()
  const terminal = {
    element: { contains: vi.fn(() => false) },
    rows: 24,
    cols: 80,
    buffer: {
      active: {
        cursorY: 23,
        viewportY: 0,
        getLine: () => ({
          getCell: () => ({ getChars: () => 'x', getWidth: () => 1 }),
          translateToString: () => 'x'.repeat(80)
        })
      }
    },
    _core: {
      _renderService: {
        _isPaused: overrides.paused === true,
        refreshRows,
        _renderer: {
          value: {
            _canvas: { width: 800, height: 480, toDataURL: () => 'data:image/png;base64,' },
            _charAtlas: {},
            _themeService: { colors: { background: { rgba: 0x000000ff } } },
            dimensions: { device: { cell: { width: 10, height: 20 } } }
          }
        }
      }
    }
  }
  return { pane: { id: 1, terminal }, refreshRows }
}

function divergenceOf(cells: number[], textCells = 1000) {
  return {
    textCells,
    missing: cells.length,
    missingCells: new Set(cells),
    missPct: (100 * cells.length) / textCells
  }
}

const manyCells = (offset: number) => Array.from({ length: 120 }, (_, i) => offset + i)

describe('terminal-render-desync-sentinel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeTerminalRenderDesyncEvidence.mockResolvedValue({
      directory: '/evidence/capture',
      pngPath: '/evidence/capture/corrupt.png',
      metadataPath: '/evidence/capture/corrupt.json'
    })
    vi.stubGlobal('window', { api: { app: { writeTerminalRenderDesyncEvidence } } })
    vi.stubGlobal('document', {
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener
    })
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    vi.stubGlobal('Node', FakeNode)
  })
  afterEach(() => {
    stopTerminalRenderDesyncSentinelForTesting()
    vi.unstubAllGlobals()
  })

  function sampleWith(
    divergence: ReturnType<typeof divergenceOf> | null,
    paused = false,
    paneKey = 'm1:p1'
  ) {
    const { pane, refreshRows } = fakePane({ paused })
    forEachLivePaneForDesyncSentinel.mockImplementation(
      (visit: (key: string, pane: unknown) => void) => visit(paneKey, pane)
    )
    sampleRenderDesyncOnce(() => divergence)
    return { refreshRows }
  }

  it('persists and recovers after the same cells stay missing twice', async () => {
    const cells = manyCells(0)
    sampleWith(divergenceOf(cells))
    expect(recordTerminalWebglDiagnostic).not.toHaveBeenCalled()
    sampleWith(divergenceOf(cells))
    expect(recordTerminalWebglDiagnostic).toHaveBeenCalledWith(
      'webgl-render-desync',
      expect.objectContaining({ paneKey: 'm1:p1', missing: 120 })
    )
    await vi.waitFor(() => expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(1))
    expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'corrupt',
        metadata: expect.objectContaining({ bufferText: expect.stringContaining('x') })
      })
    )
    expect(getRenderDesyncEvidence()).toHaveLength(1)
    expect(getRenderDesyncEvidence()[0].bufferText).toBeUndefined()
    expect(getRenderDesyncEvidence()[0].livePngDataUrl).toBeUndefined()
  })

  it('does not redraw before measuring the compositor-presented canvas', () => {
    const { refreshRows } = sampleWith(divergenceOf(manyCells(0)))
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('does not trip when the missing cells move between samples (scroll lag)', () => {
    sampleWith(divergenceOf(manyCells(0)))
    sampleWith(divergenceOf(manyCells(500)))
    sampleWith(divergenceOf(manyCells(1000)))
    sampleWith(divergenceOf(manyCells(1500)))
    expect(recordTerminalWebglDiagnostic).not.toHaveBeenCalled()
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })

  it('does not trip below the missing-percentage threshold', () => {
    const few = Array.from({ length: 10 }, (_, i) => i)
    sampleWith(divergenceOf(few))
    sampleWith(divergenceOf(few))
    expect(recordTerminalWebglDiagnostic).not.toHaveBeenCalled()
  })

  it('requires consecutive threshold breaches', () => {
    const cells = manyCells(0)
    sampleWith(divergenceOf(cells))
    sampleWith(divergenceOf(Array.from({ length: 10 }, (_, i) => i)))
    sampleWith(divergenceOf(cells))

    expect(recordTerminalWebglDiagnostic).not.toHaveBeenCalled()
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })

  it('caps capture writes while preserving recovery after the budget is spent', async () => {
    for (let pane = 1; pane <= 5; pane++) {
      sampleWith(divergenceOf(manyCells(0)), false, `m1:p${pane}`)
      sampleWith(divergenceOf(manyCells(0)), false, `m1:p${pane}`)
    }

    await vi.waitFor(() => expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledTimes(4))
    expect(getRenderDesyncEvidence()).toHaveLength(4)
    expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(5)
  })

  it('resets tracking for paused panes instead of sampling them', () => {
    const cells = manyCells(0)
    sampleWith(divergenceOf(cells))
    sampleWith(divergenceOf(cells), true)
    sampleWith(divergenceOf(cells))
    expect(recordTerminalWebglDiagnostic).not.toHaveBeenCalled()
  })

  it('stays disarmed without the flag and starts a burst on modifier-click', () => {
    vi.useFakeTimers()
    try {
      const storage = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v)
      })
      maybeStartTerminalRenderDesyncSentinel()
      const { pane } = fakePane()
      const target = new FakeNode()
      expect(forEachLivePaneForDesyncSentinel).not.toHaveBeenCalled()

      storage.set(RENDER_DESYNC_SENTINEL_FLAG, '1')
      maybeStartTerminalRenderDesyncSentinel()
      ;(
        pane.terminal as never as {
          _core: { _renderService: { _renderer: { value: { _canvas: { width: number } } } } }
        }
      )._core._renderService._renderer.value._canvas.width = 0
      ;(
        pane.terminal as { element: { contains: ReturnType<typeof vi.fn> } }
      ).element.contains.mockReturnValue(true)
      forEachLivePaneForDesyncSentinel.mockImplementation(
        (visit: (key: string, pane: unknown) => void) => visit('m1:p1', pane)
      )
      const listener = documentAddEventListener.mock.calls.at(-1)?.[1]
      listener({ button: 0, metaKey: true, ctrlKey: true, target })
      vi.advanceTimersByTime(300)
      expect(forEachLivePaneForDesyncSentinel).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
