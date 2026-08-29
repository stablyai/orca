import { describe, expect, it, vi } from 'vitest'
import {
  applyPdfWheelScale,
  applyPdfScalePreference,
  clampPdfScale,
  getNextPdfWheelScale,
  shouldHandlePdfZoomWheel,
  stepPdfScalePreference
} from './pdf-scale-preference'

const BOUNDS = { min: 0.25, max: 5, step: 1.25 }

describe('clampPdfScale', () => {
  it('clamps to the configured range', () => {
    expect(clampPdfScale(0.1, BOUNDS.min, BOUNDS.max)).toBe(0.25)
    expect(clampPdfScale(9, BOUNDS.min, BOUNDS.max)).toBe(5)
    expect(clampPdfScale(1.5, BOUNDS.min, BOUNDS.max)).toBe(1.5)
  })
})

describe('applyPdfScalePreference', () => {
  it('restores an absolute scale after a content reload', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 2.5, BOUNDS)
    expect(viewer.currentScale).toBe(2.5)
  })

  it('uses fit-to-width for the default preference', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 'page-width', BOUNDS)
    expect(viewer.currentScaleValue).toBe('page-width')
  })

  it('clamps an out-of-range absolute preference', () => {
    const viewer = { currentScale: 1, currentScaleValue: 'auto' }
    applyPdfScalePreference(viewer, 99, BOUNDS)
    expect(viewer.currentScale).toBe(5)
  })
})

describe('getNextPdfWheelScale', () => {
  it('maps wheel direction to bounded PDF zoom', () => {
    expect(getNextPdfWheelScale(1, -30, 0, BOUNDS)).toBeGreaterThan(1)
    expect(getNextPdfWheelScale(1, 30, 0, BOUNDS)).toBeLessThan(1)
    expect(getNextPdfWheelScale(BOUNDS.max, -30, 0, BOUNDS)).toBe(BOUNDS.max)
    expect(getNextPdfWheelScale(BOUNDS.min, 30, 0, BOUNDS)).toBe(BOUNDS.min)
  })
})

describe('applyPdfWheelScale', () => {
  it('zooms around the pointer and returns the applied scale', () => {
    const viewer = {
      currentScale: 1,
      updateScale: vi.fn(({ scaleFactor }: { scaleFactor: number }) => {
        viewer.currentScale *= scaleFactor
      })
    }

    const applied = applyPdfWheelScale(
      viewer,
      { clientX: 120, clientY: 240, deltaMode: 0, deltaY: -30 },
      BOUNDS
    )

    expect(applied).toBeGreaterThan(1)
    expect(viewer.updateScale).toHaveBeenCalledWith({
      scaleFactor: applied,
      origin: [120, 240]
    })
  })

  it('does not update past a scale bound', () => {
    const viewer = { currentScale: BOUNDS.max, updateScale: vi.fn() }
    expect(
      applyPdfWheelScale(viewer, { clientX: 0, clientY: 0, deltaMode: 0, deltaY: -30 }, BOUNDS)
    ).toBe(BOUNDS.max)
    expect(viewer.updateScale).not.toHaveBeenCalled()
  })

  it('seeds pdf.js before scaling its unknown internal scale', () => {
    let internalScale = 0
    const viewer = {
      get currentScale(): number {
        return internalScale || 1
      },
      set currentScale(scale: number) {
        internalScale = scale
      },
      updateScale: vi.fn(({ scaleFactor }: { scaleFactor: number }) => {
        internalScale = Math.max(0.1, internalScale * scaleFactor)
      })
    }

    const applied = applyPdfWheelScale(
      viewer,
      { clientX: 0, clientY: 0, deltaMode: 0, deltaY: 30 },
      BOUNDS
    )

    expect(applied).toBeGreaterThan(0.1)
    expect(applied).toBeCloseTo(getNextPdfWheelScale(1, 30, 0, BOUNDS))
  })
})

describe('shouldHandlePdfZoomWheel', () => {
  it('supports Ctrl/pinch gestures everywhere and Command-wheel on macOS', () => {
    expect(shouldHandlePdfZoomWheel({ ctrlKey: true, metaKey: false }, 'linux')).toBe(true)
    expect(shouldHandlePdfZoomWheel({ ctrlKey: false, metaKey: true }, 'linux')).toBe(false)
    expect(shouldHandlePdfZoomWheel({ ctrlKey: false, metaKey: true }, 'darwin')).toBe(true)
    expect(shouldHandlePdfZoomWheel({ ctrlKey: true, metaKey: false }, 'darwin')).toBe(true)
  })
})

describe('stepPdfScalePreference', () => {
  it('records the absolute scale so a later reload can restore it', () => {
    const zoomedIn = stepPdfScalePreference(1, 'in', BOUNDS)
    expect(zoomedIn.preference).toBe(1.25)
    expect(zoomedIn.scale).toBe(1.25)

    const zoomedOut = stepPdfScalePreference(1.25, 'out', BOUNDS)
    expect(zoomedOut.preference).toBe(1)
    expect(zoomedOut.scale).toBe(1)
  })
})
