import { describe, expect, it, vi } from 'vitest'
import {
  applyBrowserPageZoom,
  browserPageZoomLevelToPercent,
  forgetExplicitBrowserPageZoomLevel,
  getBrowserPageZoomIndicatorState,
  getExplicitBrowserPageZoomLevel,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  rememberExplicitBrowserPageZoomLevel,
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
    let live = 0.5
    const webview = {
      getZoomLevel: vi.fn(() => live),
      setZoomLevel: vi.fn((level: number) => {
        live = level
      })
    }

    expect(setBrowserPageZoomLevel(webview, 0)).toBe(0)
    expect(webview.setZoomLevel).toHaveBeenNthCalledWith(1, 0)
    // Chromium hands the stale level back again on the next load.
    live = 0.5
    expect(setBrowserPageZoomLevel(webview, 0)).toBe(0)
    expect(webview.setZoomLevel).toHaveBeenNthCalledWith(2, 0)
  })

  // Why: HostZoomMap is keyed by host per partition, so even a no-op write
  // overwrites the host-wide zoom a sibling tab on the same hostname set.
  it('does not write when the webview already holds the level', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn()
    }

    expect(setBrowserPageZoomLevel(webview, 0)).toBe(0)
    expect(webview.setZoomLevel).not.toHaveBeenCalled()
  })

  it('treats an unnormalized held level as already applied', () => {
    const webview = {
      getZoomLevel: vi.fn(() => 1.26),
      setZoomLevel: vi.fn()
    }

    expect(setBrowserPageZoomLevel(webview, 1.5)).toBe(1.5)
    expect(webview.setZoomLevel).not.toHaveBeenCalled()
  })
})

// A guest webview outlives its React pane (worktree switch, Settings visit), so
// the level the USER applied has to outlive the pane too — otherwise the pane
// re-seeds from the shared Settings default and hijacks an already-zoomed tab.
describe('explicit pane zoom levels', () => {
  it('reports null until the user zooms the tab', () => {
    forgetExplicitBrowserPageZoomLevel('page-1')
    expect(getExplicitBrowserPageZoomLevel('page-1')).toBeNull()
  })

  it('survives a pane remount so a later Settings default cannot hijack the tab', () => {
    forgetExplicitBrowserPageZoomLevel('page-1')
    rememberExplicitBrowserPageZoomLevel('page-1', 1.5)

    // Remount: the pane seeds from the explicit level, not the shared default.
    const settingsDefault = 0
    expect(getExplicitBrowserPageZoomLevel('page-1') ?? settingsDefault).toBe(1.5)
  })

  it('is dropped when the guest is destroyed so a reused id cannot inherit it', () => {
    rememberExplicitBrowserPageZoomLevel('page-1', 1.5)
    forgetExplicitBrowserPageZoomLevel('page-1')
    expect(getExplicitBrowserPageZoomLevel('page-1')).toBeNull()
  })

  it('keeps tabs independent', () => {
    forgetExplicitBrowserPageZoomLevel('page-2')
    rememberExplicitBrowserPageZoomLevel('page-1', 1.5)
    expect(getExplicitBrowserPageZoomLevel('page-2')).toBeNull()
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

/**
 * Chromium's HostZoomMap is keyed by HOST per partition, so two tabs on one
 * hostname share live zoom and a reassert by either moves both. Suppressing the
 * reassert to protect the sibling is exactly what #10800 fixed (an
 * externally-changed level must snap back on reload), so the two requirements
 * are the same write seen from opposite sides. What IS in our control is not
 * emitting a redundant host-wide write.
 */
describe('browser panes sharing one hostname', () => {
  it('skips the host-wide write when the pane already holds its level', () => {
    let hostLevel = 0
    const webviewFor = (): { getZoomLevel: () => number; setZoomLevel: (n: number) => void } => ({
      getZoomLevel: () => hostLevel,
      setZoomLevel: (level: number) => {
        hostLevel = level
      }
    })
    const tabA = webviewFor()
    const tabB = webviewFor()

    expect(applyBrowserPageZoom(tabA, 'in')).toBe(0.5)
    // Tab B reasserts the level the host already carries: no write at all.
    setBrowserPageZoomLevel(tabB, 0.5)

    expect(hostLevel).toBe(0.5)
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
