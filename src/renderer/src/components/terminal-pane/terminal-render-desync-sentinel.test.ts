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
  sampleRenderDesyncOnce,
  stopTerminalRenderDesyncSentinelForTesting
} from './terminal-render-desync-sentinel'
import {
  maybeStartTerminalRenderDesyncSentinel,
  RENDER_DESYNC_SENTINEL_FLAG,
  stopTerminalRenderDesyncTriggerForTesting
} from './terminal-render-desync-trigger'

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
    stopTerminalRenderDesyncTriggerForTesting()
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
        metadata: expect.objectContaining({
          bufferText: expect.stringContaining('x'),
          trigger: 'divergence',
          weightProbe: expect.objectContaining({
            totalTextCells: expect.any(Number),
            boldTextCells: expect.any(Number)
          })
        })
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

    // 4 capture recoveries + 1 budget-exhausted recovery; waiting on the reset
    // count (not the write count) keeps this robust to persist microtask depth.
    await vi.waitFor(() => expect(resetAndRefreshAllTerminalWebglAtlases).toHaveBeenCalledTimes(5))
    expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledTimes(4)
    expect(getRenderDesyncEvidence()).toHaveLength(4)
  })

  it('does not spend the capture budget on failed persistence attempts', async () => {
    writeTerminalRenderDesyncEvidence.mockRejectedValue(new Error('disk unavailable'))

    for (let pane = 1; pane <= 5; pane++) {
      sampleWith(divergenceOf(manyCells(0)), false, `m1:p${pane}`)
      sampleWith(divergenceOf(manyCells(0)), false, `m1:p${pane}`)
      await vi.waitFor(() => expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledTimes(pane))
      await vi.waitFor(() => expect(getRenderDesyncEvidence()).toHaveLength(0))
    }

    expect(getRenderDesyncEvidence()).toHaveLength(0)
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
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
      expect(documentAddEventListener).not.toHaveBeenCalled()
      const { pane } = fakePane()
      const target = new FakeNode()
      expect(forEachLivePaneForDesyncSentinel).not.toHaveBeenCalled()
      expect(writeTerminalRenderDesyncEvidence).not.toHaveBeenCalled()

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

  it('shift-modifier-click captures immediately and leaves the pane unrecovered', async () => {
    const storage = new Map<string, string>([[RENDER_DESYNC_SENTINEL_FLAG, '1']])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v)
    })
    maybeStartTerminalRenderDesyncSentinel()
    const { pane } = fakePane()
    ;(
      pane.terminal as { element: { contains: ReturnType<typeof vi.fn> } }
    ).element.contains.mockReturnValue(true)
    forEachLivePaneForDesyncSentinel.mockImplementation(
      (visit: (key: string, pane: unknown) => void) => visit('m1:p1', pane)
    )
    const listener = documentAddEventListener.mock.calls.at(-1)?.[1]
    listener({ button: 0, metaKey: true, ctrlKey: true, shiftKey: true, target: new FakeNode() })

    await vi.waitFor(() => expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledTimes(1))
    expect(writeTerminalRenderDesyncEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'corrupt',
        metadata: expect.objectContaining({ trigger: 'manual' })
      })
    )
    expect(recordTerminalWebglDiagnostic).toHaveBeenCalledWith(
      'webgl-render-desync-manual-capture',
      expect.objectContaining({ paneKey: 'm1:p1' })
    )
    // The captured state must stay on screen for further pokes: no recovery.
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
  })
})

describe('sentinel arming surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    stopTerminalRenderDesyncSentinelForTesting()
    stopTerminalRenderDesyncTriggerForTesting()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('arms live on enable and removes the listener on disable', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k)
    })
    vi.stubGlobal('document', {
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener
    })
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    const { isTerminalRenderDesyncSentinelArmed, setTerminalRenderDesyncSentinelArmed } =
      await import('./terminal-render-desync-trigger')

    expect(isTerminalRenderDesyncSentinelArmed()).toBe(false)
    setTerminalRenderDesyncSentinelArmed(true)
    expect(isTerminalRenderDesyncSentinelArmed()).toBe(true)
    // Live arm: the mouseup listener is registered without a reload.
    expect(documentAddEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true)

    setTerminalRenderDesyncSentinelArmed(false)
    expect(isTerminalRenderDesyncSentinelArmed()).toBe(false)
    expect(documentRemoveEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true)
  })

  it('keeps the live arming state when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      }
    })
    vi.stubGlobal('document', {
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener
    })
    const { isTerminalRenderDesyncSentinelArmed, setTerminalRenderDesyncSentinelArmed } =
      await import('./terminal-render-desync-trigger')

    expect(isTerminalRenderDesyncSentinelArmed()).toBe(false)
    setTerminalRenderDesyncSentinelArmed(true)
    expect(isTerminalRenderDesyncSentinelArmed()).toBe(true)
    expect(documentAddEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true)

    setTerminalRenderDesyncSentinelArmed(false)
    expect(isTerminalRenderDesyncSentinelArmed()).toBe(false)
    expect(documentRemoveEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function), true)
  })

  it('stops an active sampling burst when disarmed', async () => {
    vi.useFakeTimers()
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k)
    })
    vi.stubGlobal('document', {
      addEventListener: documentAddEventListener,
      removeEventListener: documentRemoveEventListener
    })
    vi.stubGlobal('navigator', { userAgent: 'Mac' })
    vi.stubGlobal('Node', FakeNode)
    const { isTerminalRenderDesyncSentinelArmed, setTerminalRenderDesyncSentinelArmed } =
      await import('./terminal-render-desync-trigger')
    const { pane } = fakePane()
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

    setTerminalRenderDesyncSentinelArmed(true)
    const listener = documentAddEventListener.mock.calls.at(-1)?.[1]
    listener({ button: 0, metaKey: true, target: new FakeNode() })
    expect(forEachLivePaneForDesyncSentinel).toHaveBeenCalledTimes(2)

    setTerminalRenderDesyncSentinelArmed(false)
    vi.advanceTimersByTime(1_000)
    expect(isTerminalRenderDesyncSentinelArmed()).toBe(false)
    expect(forEachLivePaneForDesyncSentinel).toHaveBeenCalledTimes(2)
  })
})
