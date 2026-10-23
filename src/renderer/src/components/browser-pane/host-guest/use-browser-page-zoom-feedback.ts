import { useCallback, useEffect, useRef, useState } from 'react'
import { browserPageZoomLevelToPercent } from '../../../../../shared/browser-page-zoom'
import { BROWSER_PAGE_ZOOM_FEEDBACK_MS } from '../describe-page/browser-annotation-geometry'
import {
  formatBrowserPageViewportSize,
  type BrowserPageViewportSize
} from './browser-page-viewport-size'

export function useBrowserPageZoomFeedback(): {
  browserZoomFeedbackVisible: boolean
  browserFeedbackLabel: string
  showBrowserZoomFeedback: (level: number) => void
  showBrowserViewportSizeFeedback: (size: BrowserPageViewportSize) => void
  hideBrowserFeedback: () => void
} {
  const [browserZoomFeedbackVisible, setBrowserZoomFeedbackVisible] = useState(false)
  // Why one label: zoom and resize share the corner badge, so the latest change wins instead of stacking.
  const [browserFeedbackLabel, setBrowserFeedbackLabel] = useState('')
  const browserZoomFeedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(browserZoomFeedbackTimerRef.current)
    }
  }, [])
  const flashBrowserFeedback = useCallback((label: string): void => {
    setBrowserFeedbackLabel(label)
    setBrowserZoomFeedbackVisible(true)
    clearTimeout(browserZoomFeedbackTimerRef.current)
    browserZoomFeedbackTimerRef.current = setTimeout(() => {
      setBrowserZoomFeedbackVisible(false)
    }, BROWSER_PAGE_ZOOM_FEEDBACK_MS)
  }, [])
  const hideBrowserFeedback = useCallback((): void => {
    clearTimeout(browserZoomFeedbackTimerRef.current)
    setBrowserZoomFeedbackVisible(false)
  }, [])
  const showBrowserZoomFeedback = useCallback(
    (level: number): void => {
      flashBrowserFeedback(`${browserPageZoomLevelToPercent(level)}%`)
    },
    [flashBrowserFeedback]
  )
  const showBrowserViewportSizeFeedback = useCallback(
    (size: BrowserPageViewportSize): void => {
      flashBrowserFeedback(formatBrowserPageViewportSize(size))
    },
    [flashBrowserFeedback]
  )

  return {
    browserZoomFeedbackVisible,
    browserFeedbackLabel,
    showBrowserZoomFeedback,
    showBrowserViewportSizeFeedback,
    hideBrowserFeedback
  }
}
