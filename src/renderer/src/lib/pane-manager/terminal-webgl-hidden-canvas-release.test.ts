// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS,
  isWebglCanvasBackingReleased,
  releaseWebglCanvasBackingWhileHidden,
  stopReleasingWebglCanvasBacking
} from './terminal-webgl-hidden-canvas-release'

type ResizeCallback = (entries: { contentRect: { width: number; height: number } }[]) => void

function makeCanvas() {
  let onResize: ResizeCallback = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeCallback) {
        onResize = callback
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  const canvas = document.createElement('canvas')
  canvas.width = 2000
  canvas.height = 1000
  return {
    canvas,
    reportBox: (width: number) => onResize([{ contentRect: { width, height: width } }])
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('releaseWebglCanvasBackingWhileHidden', () => {
  it('releases a canvas attached while hidden and restores it when a box is reported', () => {
    vi.useFakeTimers()
    const { canvas, reportBox } = makeCanvas()
    const restore = vi.fn()
    releaseWebglCanvasBackingWhileHidden(canvas, () => true, restore)

    vi.advanceTimersByTime(HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS)
    expect(canvas.width).toBe(0)
    expect(isWebglCanvasBackingReleased(canvas)).toBe(true)

    // The reveal's resize callback must restore before that frame paints.
    reportBox(500)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(isWebglCanvasBackingReleased(canvas)).toBe(false)
    stopReleasingWebglCanvasBacking(canvas)
  })

  it('keeps the backing while the veto holds or the canvas has a box', () => {
    vi.useFakeTimers()
    const vetoed = makeCanvas()
    releaseWebglCanvasBackingWhileHidden(vetoed.canvas, () => false, vi.fn())
    vi.advanceTimersByTime(HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS * 2)
    expect(vetoed.canvas.width).toBe(2000)

    const visible = makeCanvas()
    releaseWebglCanvasBackingWhileHidden(visible.canvas, () => true, vi.fn())
    visible.reportBox(500)
    vi.advanceTimersByTime(HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS * 2)
    expect(visible.canvas.width).toBe(2000)
    stopReleasingWebglCanvasBacking(vetoed.canvas)
    stopReleasingWebglCanvasBacking(visible.canvas)
  })
})
