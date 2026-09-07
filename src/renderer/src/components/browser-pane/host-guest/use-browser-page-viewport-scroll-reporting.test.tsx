// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureBrowserPageViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport,
  setBrowserPageViewportPresetSize
} from './browser-page-viewport'
import { useBrowserPageViewportScrollReporting } from './use-browser-page-viewport-scroll-reporting'

describe('useBrowserPageViewportScrollReporting', () => {
  const reportViewportScrollState = vi.fn()

  afterEach(() => {
    cleanup()
    reportViewportScrollState.mockReset()
    removeBrowserPageViewport('page-1')
    setBrowserPageViewportPresetSize('page-1', null)
    registerBrowserOverlaySlotViewport('workspace-1', null)
    vi.unstubAllGlobals()
  })

  it('reports again when the preset changes and host scroll bounds are rebuilt', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    registerBrowserOverlaySlotViewport('workspace-1', root)
    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!
    Object.defineProperties(viewport.scroller, {
      scrollWidth: { configurable: true, value: 1440 },
      scrollHeight: { configurable: true, value: 900 },
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 500 }
    })
    vi.stubGlobal('window', {
      api: { browser: { reportViewportScrollState } }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const hook = renderHook(
      ({ presetId }: { presetId: string | null }) =>
        useBrowserPageViewportScrollReporting('page-1', viewport.scroller, presetId),
      { initialProps: { presetId: null as string | null } }
    )

    expect(reportViewportScrollState).toHaveBeenCalledTimes(1)

    act(() => {
      setBrowserPageViewportPresetSize('page-1', { width: 1440, height: 900 })
      hook.rerender({ presetId: 'laptop-l' })
    })

    expect(reportViewportScrollState).toHaveBeenCalledTimes(2)
    expect(reportViewportScrollState).toHaveBeenLastCalledWith({
      browserPageId: 'page-1',
      state: {
        scrollLeft: 0,
        scrollTop: 0,
        maxScrollLeft: 840,
        maxScrollTop: 400
      }
    })
  })
})
