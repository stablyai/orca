import { describe, expect, it, vi } from 'vitest'
import {
  applyBrowserPageZoom,
  browserPageZoomLevelToPercent,
  nextBrowserPageZoomLevel
} from './browser-page-zoom'

describe('browserPageZoomLevelToPercent', () => {
  it('maps Electron zoom levels to Chromium-style percentages', () => {
    expect(browserPageZoomLevelToPercent(0)).toBe(100)
    expect(browserPageZoomLevelToPercent(0.5)).toBe(110)
    expect(browserPageZoomLevelToPercent(-0.5)).toBe(91)
    expect(browserPageZoomLevelToPercent(5)).toBe(249)
  })
})

describe('nextBrowserPageZoomLevel', () => {
  it('steps, clamps, and resets browser page zoom levels', () => {
    expect(nextBrowserPageZoomLevel(0, 'in')).toBe(0.5)
    expect(nextBrowserPageZoomLevel(0, 'out')).toBe(-0.5)
    expect(nextBrowserPageZoomLevel(3, 'reset')).toBe(0)
    expect(nextBrowserPageZoomLevel(5, 'in')).toBe(5)
    expect(nextBrowserPageZoomLevel(-3, 'out')).toBe(-3)
  })
})

describe('applyBrowserPageZoom', () => {
  it('applies the next zoom level to a live webview', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 1),
      setZoomLevel: vi.fn()
    }

    expect(applyBrowserPageZoom(webview, 'in')).toBe(1.5)
    expect(webview.setZoomLevel).toHaveBeenCalledWith(1.5)
  })

  it('returns null for missing or destroyed webviews', () => {
    expect(applyBrowserPageZoom(null, 'in')).toBeNull()
    expect(
      applyBrowserPageZoom(
        {
          isDestroyed: () => true,
          getZoomLevel: vi.fn(() => 0),
          setZoomLevel: vi.fn()
        },
        'out'
      )
    ).toBeNull()
  })

  it('returns null when webview zoom methods throw', () => {
    const getZoomFailure = {
      getZoomLevel: vi.fn(() => {
        throw new Error('detached')
      }),
      setZoomLevel: vi.fn()
    }
    const setZoomFailure = {
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(() => {
        throw new Error('destroyed')
      })
    }

    expect(applyBrowserPageZoom(getZoomFailure, 'in')).toBeNull()
    expect(applyBrowserPageZoom(setZoomFailure, 'out')).toBeNull()
  })
})
