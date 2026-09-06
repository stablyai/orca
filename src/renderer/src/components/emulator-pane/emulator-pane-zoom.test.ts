import { describe, expect, it } from 'vitest'
import {
  EMULATOR_ZOOM_LEVELS,
  resolveEmulatorZoomAvailability,
  resolveEmulatorZoomState,
  type EmulatorZoomMetrics
} from './emulator-pane-zoom'

const metrics: EmulatorZoomMetrics = { fitScale: 0.3, fitDisplayScale: 0.5 }

describe('emulator zoom', () => {
  it('uses the Android Studio discrete levels', () => {
    expect(EMULATOR_ZOOM_LEVELS).toEqual([0.0625, 0.125, 0.25, 0.5, 1, 2, 4])
  })

  it('crosses from Fit to the next discrete level and returns to Fit below it', () => {
    expect(resolveEmulatorZoomState({ mode: 'fit' }, 'in', metrics)).toEqual({
      mode: 'fixed',
      scale: 0.5
    })
    expect(resolveEmulatorZoomState({ mode: 'fixed', scale: 0.5 }, 'out', metrics)).toEqual({
      mode: 'fit'
    })
  })

  it('disables Zoom Out at Fit when the previous level is below Fit scale', () => {
    expect(resolveEmulatorZoomAvailability({ mode: 'fit' }, metrics).out).toBe(false)
  })

  it('decreases fixed zoom when Fit grows beyond the current fixed scale', () => {
    const resizedMetrics = { fitScale: 0.8, fitDisplayScale: 0.5 }

    expect(resolveEmulatorZoomAvailability({ mode: 'fixed', scale: 0.5 }, resizedMetrics).out).toBe(
      true
    )
    expect(resolveEmulatorZoomState({ mode: 'fixed', scale: 0.5 }, 'out', resizedMetrics)).toEqual({
      mode: 'fixed',
      scale: 0.25
    })
  })

  it('handles actual, display fit, and boundaries', () => {
    expect(resolveEmulatorZoomState({ mode: 'fit' }, 'actual', metrics)).toEqual({
      mode: 'fixed',
      scale: 1
    })
    expect(resolveEmulatorZoomState({ mode: 'fit' }, 'fit-display', metrics)).toEqual({
      mode: 'fit-display'
    })
    expect(resolveEmulatorZoomAvailability({ mode: 'fixed', scale: 4 }, metrics).in).toBe(false)
    expect(resolveEmulatorZoomAvailability({ mode: 'fixed', scale: 0.0625 }, metrics).out).toBe(
      false
    )
  })
})
