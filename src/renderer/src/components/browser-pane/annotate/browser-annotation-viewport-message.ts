import type { Dispatch, SetStateAction } from 'react'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../../shared/browser-annotation-viewport-bridge'
import { parseBrowserAnnotationViewportReport } from '../../../../../shared/browser-annotation-viewport-report'
import {
  applyBrowserAnnotationViewportReport,
  type BrowserOverlayViewport
} from '../describe-page/browser-annotation-geometry'

export function consumeBrowserAnnotationViewportMessage(
  event: { message?: string },
  token: string,
  setViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
): void {
  const message = typeof event.message === 'string' ? event.message : ''
  const prefix = `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:`
  if (!message.startsWith(prefix)) {
    return
  }
  const report = parseBrowserAnnotationViewportReport(message.slice(prefix.length))
  if (report) {
    setViewport((current) => applyBrowserAnnotationViewportReport(current, report))
  }
}
