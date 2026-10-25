// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserViewportPresetId } from '../../../../shared/browser-workspace-types'
import { useClientHostedBrowserViewport } from './use-client-hosted-browser-viewport'

const apply = vi.fn(async () => true)
beforeEach(() => {
  apply.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: { setViewportOverride: apply }
    }
  })
})
afterEach(cleanup)

describe('client-hosted viewport presets', () => {
  it('applies mobile metrics to its page and restores the default without replacing the guest', () => {
    const content = document.createElement('div')
    const scroller = document.createElement('div')
    const guest = document.createElement('webview')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook only calls EventTarget methods on the guest.
    const webview = guest as Electron.WebviewTag
    const initialProps: { presetId: BrowserViewportPresetId | null; generation: number | null } = {
      presetId: 'mobile-m',
      generation: 7
    }
    const { rerender, unmount } = renderHook(
      ({
        presetId,
        generation
      }: {
        presetId: BrowserViewportPresetId | null
        generation: number | null
      }) =>
        useClientHostedBrowserViewport({
          browserPageId: 'remote-page-a',
          presetId,
          pageHostGeneration: generation,
          contentRef: { current: content },
          scrollerRef: { current: scroller },
          webviewRef: { current: webview }
        }),
      { initialProps }
    )
    expect(apply).toHaveBeenLastCalledWith({
      browserPageId: 'remote-page-a',
      override: {
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true
      }
    })
    expect(content.style.getPropertyValue('--browser-page-viewport-width')).toBe('375px')
    expect(scroller.style.overflow).toBe('auto')
    act(() => guest.dispatchEvent(new Event('dom-ready')))
    expect(apply).toHaveBeenCalledTimes(2)
    rerender({ presetId: null, generation: 7 })
    expect(apply).toHaveBeenLastCalledWith({ browserPageId: 'remote-page-a', override: null })
    expect(content.style.width).toBe('100%')
    expect(content.classList.contains('browser-page-preset-viewport')).toBe(false)
    expect(scroller.style.overflow).toBe('')
    unmount()
    const calls = apply.mock.calls.length
    act(() => guest.dispatchEvent(new Event('dom-ready')))
    expect(apply).toHaveBeenCalledTimes(calls)
  })

  it('routes preset panning to its own scroller and reports that scroller, not a local page', async () => {
    let listener:
      | ((event: { browserPageId: string; deltaX: number; deltaY: number }) => void)
      | undefined
    const unsubscribe = vi.fn()
    const report = vi.fn()
    window.api.browser.reportViewportScrollState = report
    Object.defineProperty(window.api, 'ui', {
      configurable: true,
      value: {
        onScrollBrowserPage: (callback: typeof listener) => {
          listener = callback
          return unsubscribe
        }
      }
    })
    const content = document.createElement('div')
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
      scrollWidth: { value: 1024 },
      clientWidth: { value: 300 },
      scrollHeight: { value: 768 },
      clientHeight: { value: 200 }
    })
    const { unmount } = renderHook(() =>
      useClientHostedBrowserViewport({
        browserPageId: 'remote-panning',
        presetId: 'tablet',
        pageHostGeneration: null,
        contentRef: { current: content },
        scrollerRef: { current: scroller },
        webviewRef: { current: null }
      })
    )
    act(() => listener?.({ browserPageId: 'other-page', deltaX: 9, deltaY: 11 }))
    expect(scroller.scrollLeft).toBe(0)
    act(() => {
      listener?.({ browserPageId: 'remote-panning', deltaX: 9, deltaY: 11 })
      scroller.dispatchEvent(new Event('scroll'))
    })
    expect(scroller.scrollLeft).toBe(9)
    expect(scroller.scrollTop).toBe(11)
    await waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        browserPageId: 'remote-panning',
        state: {
          scrollLeft: 9,
          scrollTop: 11,
          maxScrollLeft: 724,
          maxScrollTop: 568
        }
      })
    )
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not send viewport commands for an unplaced page', () => {
    renderHook(() =>
      useClientHostedBrowserViewport({
        browserPageId: 'unplaced',
        presetId: 'mobile-m',
        pageHostGeneration: null,
        contentRef: { current: null },
        scrollerRef: { current: null },
        webviewRef: { current: null }
      })
    )
    expect(apply).not.toHaveBeenCalled()
  })
})
