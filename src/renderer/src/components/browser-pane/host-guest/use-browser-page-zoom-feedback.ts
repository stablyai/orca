import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  browserPageZoomLevelToPercent,
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  getExplicitBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel
} from './browser-page-zoom'
import { BROWSER_PAGE_ZOOM_FEEDBACK_MS } from '../describe-page/browser-annotation-geometry'

export function useBrowserPageZoomFeedback(browserTabId: string): {
  paneZoomLevelRef: React.MutableRefObject<number>
  browserZoomPercent: number
  setBrowserZoomPercent: React.Dispatch<React.SetStateAction<number>>
  browserZoomFeedbackVisible: boolean
  showBrowserZoomFeedback: (level: number) => void
  browserDefaultZoomPercent: number
  setBrowserDefaultZoomLevel: (level: number) => void
} {
  const browserDefaultZoomLevel = useAppStore(
    (state) => state.browserDefaultZoomLevel ?? DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
  )
  const setBrowserDefaultZoomLevel = useAppStore((state) => state.setBrowserDefaultZoomLevel)
  const normalizedBrowserDefaultZoomLevel = normalizeBrowserPageZoomLevel(browserDefaultZoomLevel)
  const browserDefaultZoomPercent = browserPageZoomLevelToPercent(normalizedBrowserDefaultZoomLevel)
  // Why: the level THIS pane should hold. Seeded from the configured default ("applied to newly
  // opened browser tabs") and moved only by zooming this pane, so a reload can't broadcast another
  // tab's zoom through the shared setting. Why the module-level lookup: the guest webview outlives
  // this component (worktree switch, Settings visit), so re-seeding on remount would let a later
  // Settings change retroactively hijack a tab the user already zoomed.
  const paneZoomLevelRef = useRef(
    getExplicitBrowserPageZoomLevel(browserTabId) ?? normalizedBrowserDefaultZoomLevel
  )
  const [browserZoomPercent, setBrowserZoomPercent] = useState(browserDefaultZoomPercent)
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

  return {
    paneZoomLevelRef,
    browserZoomPercent,
    setBrowserZoomPercent,
    browserZoomFeedbackVisible,
    showBrowserZoomFeedback,
    browserDefaultZoomPercent,
    setBrowserDefaultZoomLevel
  }
}
