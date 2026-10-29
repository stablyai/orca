import { useCallback, useEffect, useRef, useState } from 'react'
import { browserPageZoomLevelToPercent } from '../../../../../shared/browser-page-zoom'
import { BROWSER_PAGE_ZOOM_FEEDBACK_MS } from '../describe-page/browser-annotation-geometry'

export function useBrowserPageZoomFeedback(): {
  browserZoomPercent: number
  browserZoomFeedbackVisible: boolean
  showBrowserZoomFeedback: (level: number) => void
} {
  const [browserZoomPercent, setBrowserZoomPercent] = useState(100)
  const [browserZoomFeedbackVisible, setBrowserZoomFeedbackVisible] = useState(false)
  const browserZoomFeedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(browserZoomFeedbackTimerRef.current)
    }
  }, [])
  const showBrowserZoomFeedback = useCallback((level: number): void => {
    setBrowserZoomPercent(browserPageZoomLevelToPercent(level))
    setBrowserZoomFeedbackVisible(true)
    clearTimeout(browserZoomFeedbackTimerRef.current)
    browserZoomFeedbackTimerRef.current = setTimeout(() => {
      setBrowserZoomFeedbackVisible(false)
    }, BROWSER_PAGE_ZOOM_FEEDBACK_MS)
  }, [])

  return { browserZoomPercent, browserZoomFeedbackVisible, showBrowserZoomFeedback }
}
