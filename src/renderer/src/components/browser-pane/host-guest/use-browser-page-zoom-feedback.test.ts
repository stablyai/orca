// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_ZOOM_FEEDBACK_MS } from '../describe-page/browser-annotation-geometry'
import { useBrowserPageZoomFeedback } from './use-browser-page-zoom-feedback'

const ZOOM_125_LEVEL = Math.log(1.25) / Math.log(1.2)

describe('useBrowserPageZoomFeedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows the latest of zoom and size feedback in one badge', () => {
    const { result } = renderHook(() => useBrowserPageZoomFeedback())
    act(() => result.current.showBrowserZoomFeedback(ZOOM_125_LEVEL))
    expect(result.current.browserFeedbackLabel).toBe('125%')
    act(() => result.current.showBrowserViewportSizeFeedback({ width: 1024, height: 768 }))
    expect(result.current.browserFeedbackLabel).toBe('1024 × 768')
    expect(result.current.browserZoomFeedbackVisible).toBe(true)
  })

  it('restarts the fade timer on each flash', () => {
    const { result } = renderHook(() => useBrowserPageZoomFeedback())
    act(() => result.current.showBrowserZoomFeedback(ZOOM_125_LEVEL))
    act(() => vi.advanceTimersByTime(BROWSER_PAGE_ZOOM_FEEDBACK_MS - 100))
    act(() => result.current.showBrowserViewportSizeFeedback({ width: 800, height: 600 }))
    act(() => vi.advanceTimersByTime(BROWSER_PAGE_ZOOM_FEEDBACK_MS - 100))
    expect(result.current.browserZoomFeedbackVisible).toBe(true)
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.browserZoomFeedbackVisible).toBe(false)
    expect(result.current.browserFeedbackLabel).toBe('800 × 600')
  })
})
