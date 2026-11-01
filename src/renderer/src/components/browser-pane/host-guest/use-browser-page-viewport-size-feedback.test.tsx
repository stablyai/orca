// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPageViewportSizeFeedback } from './use-browser-page-viewport-size-feedback'

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
