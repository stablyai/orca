import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import {
  repairPaneWebglCanvasDpr,
  repairPaneWebglCanvasDprMismatch
} from './terminal-canvas-dpr-repair'

function makePane(args: {
  backingWidth: number
  expectedWidth: number
  dpr: number
  cachedDpr?: number
  backingHeight?: number
  expectedHeight?: number
  connected?: boolean
  hasRenderer?: boolean
}): {
  pane: ManagedPane
  handleDevicePixelRatioChange: ReturnType<typeof vi.fn>
  handleResize: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
} {
  const handleDevicePixelRatioChange = vi.fn()
  const handleResize = vi.fn()
  const refresh = vi.fn()
  const canvas = {
    width: args.backingWidth,
    height: args.backingHeight ?? 1200,
    isConnected: args.connected ?? true,
    ownerDocument: { defaultView: { devicePixelRatio: args.dpr } },
    getBoundingClientRect: () => {
      throw new Error('repair detection must not force layout')
    }
  }
  const renderer =
    (args.hasRenderer ?? true)
      ? {
          _canvas: canvas,
          _devicePixelRatio: args.cachedDpr ?? args.dpr,
          dimensions: {
            device: {
              canvas: { width: args.expectedWidth, height: args.expectedHeight ?? 1200 }
            }
          },
          handleDevicePixelRatioChange,
          handleResize
        }
      : undefined
  const pane = {
    id: 1,
    terminal: {
      cols: 120,
      rows: 40,
      refresh,
      _core: { _renderService: { _renderer: { value: renderer } } }
    }
  } as unknown as ManagedPane
  return { pane, handleDevicePixelRatioChange, handleResize, refresh }
}

describe('repairPaneWebglCanvasDprMismatch', () => {
  it('repairs a stale dpr-2 backing composited on a dpr-1 display', () => {
    // The reproduced field bug: hidden-time display change leaves a 2160px
    // backing behind a 1080px css box at dpr 1 (half-size/smeared text).
    const { pane, handleDevicePixelRatioChange, handleResize, refresh } = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1
    })

    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(true)
    expect(handleDevicePixelRatioChange).toHaveBeenCalledTimes(1)
    expect(handleResize).toHaveBeenCalledWith(120, 40)
    expect(refresh).toHaveBeenCalledWith(0, 39)
    // Dpr refresh must precede the resize that rebuilds the backing store.
    expect(handleDevicePixelRatioChange.mock.invocationCallOrder[0]!).toBeLessThan(
      handleResize.mock.invocationCallOrder[0]!
    )
  })

  it('repairs the opposite direction (dpr-1 backing upscaled on retina)', () => {
    const { pane, handleResize } = makePane({ backingWidth: 1080, expectedWidth: 2160, dpr: 2 })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('repairs when the canvas and renderer dimensions share a stale dpr cache', () => {
    const { pane, handleDevicePixelRatioChange, handleResize } = makePane({
      backingWidth: 1080,
      expectedWidth: 1080,
      dpr: 2,
      cachedDpr: 1
    })

    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(true)
    expect(handleDevicePixelRatioChange).toHaveBeenCalledTimes(1)
    expect(handleResize).toHaveBeenCalledWith(120, 40)
  })

  it('is a no-op when backing matches the renderer device dimensions', () => {
    const { pane, handleResize, refresh } = makePane({
      backingWidth: 2160,
      expectedWidth: 2160,
      dpr: 2
    })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('tolerates sub-pixel rounding without churning', () => {
    // ResizeObserver can round one device pixel away from renderer dimensions.
    const { pane, handleResize } = makePane({ backingWidth: 2160, expectedWidth: 2161, dpr: 2 })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('tolerates the larger device-pixel round trip on high-dpr displays', () => {
    const { pane, handleResize } = makePane({ backingWidth: 2160, expectedWidth: 2162, dpr: 4 })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(false)
    expect(handleResize).not.toHaveBeenCalled()
  })

  it('repairs when only the canvas height has stale backing', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2160,
      expectedWidth: 2160,
      dpr: 2,
      backingHeight: 600,
      expectedHeight: 1200
    })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(true)
    expect(handleResize).toHaveBeenCalledTimes(1)
  })

  it('skips detached, zero-dimension, and renderer-less panes', () => {
    const detached = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1,
      connected: false
    })
    expect(repairPaneWebglCanvasDprMismatch(detached.pane)).toBe(false)

    const zeroDimension = makePane({ backingWidth: 2160, expectedWidth: 0, dpr: 1 })
    expect(repairPaneWebglCanvasDprMismatch(zeroDimension.pane)).toBe(false)

    const noRenderer = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1,
      hasRenderer: false
    })
    expect(repairPaneWebglCanvasDprMismatch(noRenderer.pane)).toBe(false)
  })

  it('defers an unmeasurable WebGL canvas but accepts a renderer-less pane', () => {
    const detached = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1,
      connected: false
    })
    const noRenderer = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1,
      hasRenderer: false
    })

    expect(repairPaneWebglCanvasDpr(detached.pane)).toBe('deferred')
    expect(repairPaneWebglCanvasDpr(noRenderer.pane)).toBe('current')
  })

  it('reports failure without throwing when the repair path throws mid-teardown', () => {
    const { pane, handleResize } = makePane({
      backingWidth: 2160,
      expectedWidth: 1080,
      dpr: 1
    })
    handleResize.mockImplementation(() => {
      throw new Error('disposed')
    })
    expect(repairPaneWebglCanvasDprMismatch(pane)).toBe(false)
  })
})
