import { describe, expect, it } from 'vitest'
import {
  MAESTRO_MIN_ZOOM,
  isMaestroCanvasBoundsVisible,
  panMaestroViewport,
  revealMaestroCanvasBounds,
  zoomMaestroViewportAtPointer
} from './maestro-canvas-viewport'

describe('Maestro canvas viewport', () => {
  it('zooms far enough out to survey a large workspace', () => {
    const zoomed = zoomMaestroViewportAtPointer(
      { center: { x: 0, y: 0 }, zoom: 1 },
      { width: 1600, height: 900 },
      { x: 800, y: 450 },
      0.01
    )

    expect(zoomed.zoom).toBe(MAESTRO_MIN_ZOOM)
    expect(zoomed.zoom).toBe(0.025)
  })

  it('keeps the pointer world coordinate stable while zooming', () => {
    const viewport = { center: { x: 400, y: 300 }, zoom: 1 }
    const zoomed = zoomMaestroViewportAtPointer(
      viewport,
      { width: 800, height: 600 },
      { x: 600, y: 150 },
      2
    )

    expect(zoomed).toEqual({ center: { x: 500, y: 225 }, zoom: 2 })
  })

  it('uses the measured notebook aspect ratio for culling', () => {
    const viewport = { center: { x: 0, y: 0 }, zoom: 1 }
    expect(
      isMaestroCanvasBoundsVisible(
        { x: 670, y: 250, width: 180, height: 84 },
        viewport,
        { width: 1366, height: 768 },
        0
      )
    ).toBe(true)
    expect(
      isMaestroCanvasBoundsVisible(
        { x: 670, y: 250, width: 180, height: 84 },
        viewport,
        { width: 800, height: 600 },
        0
      )
    ).toBe(false)
  })

  it('accumulates sequential pan deltas from the latest viewport', () => {
    const first = panMaestroViewport({ center: { x: 100, y: 50 }, zoom: 2 }, { x: 20, y: -10 })
    const second = panMaestroViewport(first, { x: 40, y: 30 })

    expect(second).toEqual({ center: { x: 70, y: 40 }, zoom: 2 })
  })

  it('reveals a selected window beside the notebook Inspector without changing zoom', () => {
    const revealed = revealMaestroCanvasBounds(
      { center: { x: 0, y: 0 }, zoom: 1 },
      { width: 735, height: 700 },
      { x: 200, y: -110, width: 320, height: 220 },
      { top: 56, right: 344, bottom: 12, left: 12 }
    )
    const screenLeft = 735 / 2 + (200 - revealed.center.x) * revealed.zoom
    const screenRight = screenLeft + 320 * revealed.zoom

    expect(revealed.zoom).toBe(1)
    expect(screenLeft).toBeGreaterThanOrEqual(12)
    expect(screenRight).toBeLessThanOrEqual(735 - 344)
  })

  it('keeps a visible new surface and persisted viewport unchanged', () => {
    const viewport = { center: { x: 80, y: 20 }, zoom: 0.75 }

    expect(
      revealMaestroCanvasBounds(
        viewport,
        { width: 735, height: 700 },
        { x: -160, y: -110, width: 320, height: 220 },
        { top: 56, right: 12, bottom: 12, left: 12 }
      )
    ).toBe(viewport)
  })

  it('zooms out enough to reveal a larger terminal beside the notebook Inspector', () => {
    const revealed = revealMaestroCanvasBounds(
      { center: { x: 0, y: 0 }, zoom: 1 },
      { width: 735, height: 700 },
      { x: 0, y: 0, width: 480, height: 320 },
      { top: 56, right: 344, bottom: 12, left: 16 }
    )

    expect(revealed.zoom).toBeCloseTo(375 / 480)
  })
})
