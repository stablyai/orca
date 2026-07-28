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

  it('restores the configured level when Chromium carries zoom across reloads', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 0.5),
      setZoomLevel: vi.fn()
    }

    expect(setBrowserPageZoomLevel(webview, 0)).toBe(0)
    expect(setBrowserPageZoomLevel(webview, 0)).toBe(0)
    expect(webview.setZoomLevel).toHaveBeenNthCalledWith(1, 0)
    expect(webview.setZoomLevel).toHaveBeenNthCalledWith(2, 0)
  })
})

/**
 * Models BrowserPagePane's zoom wiring: each pane keeps its own level, dom-ready reasserts
 * that level, and zooming also writes the shared `browserDefaultZoomLevel` setting.
 */
describe('browser pane zoom across reloads', () => {
  function createPane(sharedSetting: { level: number }) {
    // Chromium remembers zoom per origin and replays it on reload.
    const originZoom = new Map<string, number>()
    let url = 'https://a.example'
    let live = 0
    const webview = {
      getZoomLevel: () => live,
      setZoomLevel: (level: number) => {
        live = level
        originZoom.set(url, level)
      }
    }
    let paneLevel = sharedSetting.level
    webview.setZoomLevel(paneLevel)

    return {
      get level() {
        return live
      },
      zoom(direction: 'in' | 'out' | 'reset') {
        const next = applyBrowserPageZoom(webview, direction)
        if (next !== null) {
          paneLevel = next
          sharedSetting.level = next
        }
      },
      load(nextUrl = url) {
        url = nextUrl
        live = originZoom.get(url) ?? 0
        setBrowserPageZoomLevel(webview, paneLevel)
      }
    }
  }

  it('reasserts the pane level after normal and hard reloads', () => {
    const setting = { level: 0 }
    const pane = createPane(setting)

    // Chromium hands back a stale 150% for this origin on reload.
    pane.load()
    expect(pane.level).toBe(0)
    pane.load()
    expect(pane.level).toBe(0)
  })

  it('keeps an explicit non-default configured zoom across a reload', () => {
    const setting = { level: 1.5 }
    const pane = createPane(setting)
    expect(pane.level).toBe(1.5)

    pane.load()
    expect(pane.level).toBe(1.5)
  })

  it('resets to 100% on reset even after zooming moved the shared setting', () => {
    const setting = { level: 0 }
    const pane = createPane(setting)

    pane.zoom('in')
    pane.zoom('in')
    expect(pane.level).toBe(1)
    expect(setting.level).toBe(1)

    // Regression: resetting toward the shared setting would be a fixed point and never move.
    pane.zoom('reset')
    expect(pane.level).toBe(0)
  })

  it('does not adopt another tab zoom when reloading an untouched tab', () => {
    const setting = { level: 0 }
    const tabA = createPane(setting)
    const tabB = createPane(setting)

    tabB.zoom('in')
    tabB.zoom('in')
    expect(tabB.level).toBe(1)
    expect(setting.level).toBe(1)
    expect(tabA.level).toBe(0)

    // Regression: reasserting the shared setting would silently zoom tab A to tab B's level.
    tabA.load()
    expect(tabA.level).toBe(0)
  })

  it('keeps a zoomed tab at its own level across reload and cross-origin navigation', () => {
    const setting = { level: 0 }
    const pane = createPane(setting)

    pane.zoom('in')
    expect(pane.level).toBe(0.5)

    pane.load()
    expect(pane.level).toBe(0.5)
    pane.load('https://b.example')
    expect(pane.level).toBe(0.5)
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
