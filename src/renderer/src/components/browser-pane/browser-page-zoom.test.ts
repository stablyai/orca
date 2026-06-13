import { describe, expect, it, vi } from 'vitest'
import {
  applyBrowserPageZoom,
  browserPageZoomLevelToPercent,
  getBrowserPageZoomIndicatorState,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  setBrowserPageZoomLevel
} from './browser-page-zoom'

describe('browserPageZoomLevelToPercent', () => {
  it('maps Electron zoom levels to Chromium-style percentages', () => {
    expect(browserPageZoomLevelToPercent(0)).toBe(100)
    expect(browserPageZoomLevelToPercent(0.5)).toBe(110)
    expect(browserPageZoomLevelToPercent(-0.5)).toBe(91)
    expect(browserPageZoomLevelToPercent(5)).toBe(249)
  })
})

describe('normalizeBrowserPageZoomLevel', () => {
  it('rounds to supported steps and clamps to Electron zoom bounds', () => {
    expect(normalizeBrowserPageZoomLevel(1.24)).toBe(1)
    expect(normalizeBrowserPageZoomLevel(1.26)).toBe(1.5)
    expect(normalizeBrowserPageZoomLevel(10)).toBe(5)
    expect(normalizeBrowserPageZoomLevel(-10)).toBe(-3)
    expect(normalizeBrowserPageZoomLevel(Number.NaN)).toBe(0)
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

  it('resets to the configured default zoom level', () => {
    expect(nextBrowserPageZoomLevel(3, 'reset', 1)).toBe(1)
    expect(nextBrowserPageZoomLevel(3, 'reset', 1.26)).toBe(1.5)
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

  it('resets the webview to the configured default zoom level', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 2),
      setZoomLevel: vi.fn()
    }

    expect(applyBrowserPageZoom(webview, 'reset', 1)).toBe(1)
    expect(webview.setZoomLevel).toHaveBeenCalledWith(1)
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

describe('setBrowserPageZoomLevel', () => {
  it('normalizes and applies an explicit zoom level', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn()
    }

    expect(setBrowserPageZoomLevel(webview, 1.26)).toBe(1.5)
    expect(webview.setZoomLevel).toHaveBeenCalledWith(1.5)
  })
})

describe('getBrowserPageZoomIndicatorState', () => {
  it('shows browser zoom percent only while feedback is active', () => {
    expect(
      getBrowserPageZoomIndicatorState({ feedbackVisible: true, isDefaultZoom: false })
    ).toEqual({
      ariaHidden: false,
      opacityClassName: 'opacity-100'
    })
    expect(
      getBrowserPageZoomIndicatorState({ feedbackVisible: false, isDefaultZoom: false })
    ).toEqual({
      ariaHidden: true,
      opacityClassName: 'opacity-0'
    })
  })
})
