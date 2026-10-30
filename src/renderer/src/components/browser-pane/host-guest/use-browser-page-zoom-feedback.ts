import { useCallback, useRef, type RefObject } from 'react'
import { browserPageZoomLevelToPercent } from '../../../../../shared/browser-page-zoom'
import type { BrowserPageFeedbackBadgeHandle } from '../assemble-chrome/browser-page-feedback-badge'
import type { BrowserPageViewportSize } from './use-browser-page-viewport-size-feedback'

export function useBrowserPageZoomFeedback(): {
  feedbackBadgeRef: RefObject<BrowserPageFeedbackBadgeHandle | null>
  showBrowserZoomFeedback: (level: number) => void
  showBrowserViewportSizeFeedback: (size: BrowserPageViewportSize) => void
  hideBrowserFeedback: () => void
} {
  // Why one badge: zoom and resize share the corner, so the latest change wins instead of stacking.
  const feedbackBadgeRef = useRef<BrowserPageFeedbackBadgeHandle>(null)
  const showBrowserZoomFeedback = useCallback((level: number): void => {
    feedbackBadgeRef.current?.flash(`${browserPageZoomLevelToPercent(level)}%`)
  }, [])
  const showBrowserViewportSizeFeedback = useCallback((size: BrowserPageViewportSize): void => {
    feedbackBadgeRef.current?.flash(`${size.width} × ${size.height}`)
  }, [])
  const hideBrowserFeedback = useCallback((): void => {
    feedbackBadgeRef.current?.hide()
  }, [])

  return {
    feedbackBadgeRef,
    showBrowserZoomFeedback,
    showBrowserViewportSizeFeedback,
    hideBrowserFeedback
  }
}
