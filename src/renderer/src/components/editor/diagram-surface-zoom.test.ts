import { describe, expect, it } from 'vitest'
import {
  MAX_DIAGRAM_SURFACE_ZOOM,
  MIN_DIAGRAM_SURFACE_ZOOM,
  getDiagramSurfaceKeyboardZoomIntent,
  getDraggedDiagramSurfaceScrollPosition,
  getZoomedDiagramLayoutSize
} from './diagram-surface-zoom'

describe('diagram surface zoom helpers', () => {
  it('fits large diagrams before applying user zoom', () => {
    expect(
      getZoomedDiagramLayoutSize({
        diagramDimensions: { width: 1200, height: 600 },
        surfaceSize: { width: 624, height: 424 },
        zoom: 1
      })
    ).toEqual({ width: 576, height: 288 })

    expect(
      getZoomedDiagramLayoutSize({
        diagramDimensions: { width: 1200, height: 600 },
        surfaceSize: { width: 624, height: 424 },
        zoom: 2
      })
    ).toEqual({ width: 1152, height: 576 })
  })

  it('does not upscale small diagrams at 100 percent', () => {
    expect(
      getZoomedDiagramLayoutSize({
        diagramDimensions: { width: 200, height: 100 },
        surfaceSize: { width: 800, height: 600 },
        zoom: 1
      })
    ).toEqual({ width: 200, height: 100 })
  })

  it('clamps the layout zoom to diagram bounds', () => {
    expect(
      getZoomedDiagramLayoutSize({
        diagramDimensions: { width: 100, height: 50 },
        surfaceSize: { width: 800, height: 600 },
        zoom: 0.01
      })
    ).toEqual({ width: 100 * MIN_DIAGRAM_SURFACE_ZOOM, height: 50 * MIN_DIAGRAM_SURFACE_ZOOM })

    expect(
      getZoomedDiagramLayoutSize({
        diagramDimensions: { width: 100, height: 50 },
        surfaceSize: { width: 800, height: 600 },
        zoom: 20
      })
    ).toEqual({ width: 100 * MAX_DIAGRAM_SURFACE_ZOOM, height: 50 * MAX_DIAGRAM_SURFACE_ZOOM })
  })

  it('maps platform zoom shortcuts to diagram zoom intents', () => {
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '+', code: 'Equal', ctrlKey: false, metaKey: true, altKey: false },
        'darwin'
      )
    ).toBe('zoom-in')
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '-', code: 'Minus', ctrlKey: true, metaKey: false, altKey: false },
        'win32'
      )
    ).toBe('zoom-out')
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '0', code: 'Digit0', ctrlKey: true, metaKey: false, altKey: false },
        'linux'
      )
    ).toBe('reset')
  })

  it('ignores non-platform zoom modifiers', () => {
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false },
        'darwin'
      )
    ).toBeNull()
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '+', code: 'Equal', ctrlKey: false, metaKey: true, altKey: false },
        'win32'
      )
    ).toBeNull()
    expect(
      getDiagramSurfaceKeyboardZoomIntent(
        { key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: true },
        'linux'
      )
    ).toBeNull()
  })

  it('converts drag distance into scroll position', () => {
    expect(
      getDraggedDiagramSurfaceScrollPosition({
        start: { clientX: 300, clientY: 200, scrollLeft: 80, scrollTop: 50 },
        clientX: 240,
        clientY: 260
      })
    ).toEqual({ scrollLeft: 140, scrollTop: -10 })
  })
})
