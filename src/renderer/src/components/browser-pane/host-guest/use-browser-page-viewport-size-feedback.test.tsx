// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  toBrowserPageGuestViewportSize,
  useBrowserPageViewportSizeFeedback,
  type BrowserPageViewportSize
} from './use-browser-page-viewport-size-feedback'

vi.mock('@/lib/ui-zoom', () => ({ getUIZoomFactor: () => 1 }))

let observerCallbacks: ResizeObserverCallback[] = []

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    observerCallbacks.push(callback)
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

function resizeTo(width: number, height: number): void {
  const entry = { contentRect: { width, height } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reads contentRect width and height.
  observerCallbacks.at(-1)?.([entry] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
}

it('matches what the guest reported under UI zoom, page zoom and a 2x screen', () => {
  const cases: [BrowserPageViewportSize, number, number, BrowserPageViewportSize][] = [
    [{ width: 569, height: 689 }, 1, 1, { width: 569, height: 689 }],
    // 1x screen, 1.2 UI zoom: 410.83 CSS px is 493 DIP.
    [{ width: 410.8333 * 1.2, height: 555.677 * 1.2 }, 1, 1.2, { width: 411, height: 556 }],
    [{ width: 669, height: 689 }, 1, 0.9, { width: 743, height: 765 }],
    // 2x screen: the screen scale joins the page zoom, so 90% divides by 1.8 and 125% by 2.5.
    [{ width: 872, height: 895.5 }, 2, 0.9, { width: 969, height: 995 }],
    [{ width: 1569, height: 1189 }, 2, 1.25, { width: 1255, height: 951 }],
    // Blink adds 0.5, not 1, before dividing when zoomed in.
    [{ width: 1000, height: 1610 }, 1, 1.1, { width: 909, height: 1464 }],
    // The guest frame is rounded up to whole DIPs before the screen scale.
    [{ width: 800.5, height: 600 }, 2, 0.5, { width: 1602, height: 1200 }],
    // 2x screen at 1.2 UI zoom: a 731.9987 × 890.6771 CSS px box at 90%.
    [{ width: 731.9987 * 1.2, height: 890.6771 * 1.2 }, 2, 0.9, { width: 976, height: 1188 }]
  ]
  for (const [hostDip, screenScale, pageZoomFactor, guest] of cases) {
    expect(toBrowserPageGuestViewportSize(hostDip, screenScale, pageZoomFactor)).toEqual(guest)
  }
})

describe('useBrowserPageViewportSizeFeedback', () => {
  const showBrowserViewportSizeFeedback = vi.fn()
  const hideBrowserFeedback = vi.fn()
  beforeEach(() => {
    observerCallbacks = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    cleanup()
    showBrowserViewportSizeFeedback.mockReset()
    hideBrowserFeedback.mockReset()
    vi.unstubAllGlobals()
  })

  function renderFeedback(isActive: boolean, getGuestZoomLevel: () => number = () => 0) {
    const content = document.createElement('div')
    const webviewRef = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only calls getZoomLevel on the guest.
      current: { getZoomLevel: getGuestZoomLevel } as unknown as Electron.WebviewTag
    }
    return renderHook(
      ({ active }) =>
        useBrowserPageViewportSizeFeedback(content, active, webviewRef, {
          showBrowserViewportSizeFeedback,
          hideBrowserFeedback
        }),
      { initialProps: { active: isActive } }
    )
  }

  it('reports a resize but not the initial measurement', () => {
    renderFeedback(true)
    resizeTo(800, 600)
    expect(showBrowserViewportSizeFeedback).not.toHaveBeenCalled()
    resizeTo(760, 600)
    expect(showBrowserViewportSizeFeedback).toHaveBeenCalledWith({ width: 760, height: 600 })
  })

  it('announces the first resize when the opening measurement came before dom-ready', () => {
    let ready = false
    renderFeedback(true, () => {
      if (!ready) {
        throw new Error('not dom-ready')
      }
      return 1
    })
    resizeTo(1200, 600)
    ready = true
    resizeTo(1080, 600)
    // Both sides convert at the zoom readable now (level 1 is 1.2), so the badge shows 900 × 500.
    expect(showBrowserViewportSizeFeedback).toHaveBeenCalledWith({ width: 900, height: 500 })
  })

  it('hides a running flash when the page is parked at 0×0', () => {
    renderFeedback(true)
    resizeTo(800, 600)
    resizeTo(760, 600)
    resizeTo(0, 0)
    expect(hideBrowserFeedback).toHaveBeenCalledTimes(1)
    // Shown again at a new size: a baseline, not a resize.
    resizeTo(900, 600)
    expect(showBrowserViewportSizeFeedback).toHaveBeenCalledTimes(1)
  })

  it('treats reactivation as a fresh first measurement', () => {
    const view = renderFeedback(true)
    resizeTo(800, 600)
    view.rerender({ active: false })
    expect(hideBrowserFeedback).toHaveBeenCalledTimes(1)
    view.rerender({ active: true })
    // A tab shown again at a new size is not a resize.
    resizeTo(1000, 600)
    expect(showBrowserViewportSizeFeedback).not.toHaveBeenCalled()
    resizeTo(960, 600)
    expect(showBrowserViewportSizeFeedback).toHaveBeenCalledWith({ width: 960, height: 600 })
  })
})
