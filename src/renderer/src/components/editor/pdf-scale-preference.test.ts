import { describe, expect, it } from 'vitest'
import {
  applyPdfScalePreference,
  clampPdfScale,
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
