import { useCallback, type MutableRefObject } from 'react'
import { deliverMarkupToClipboard } from './markup-clipboard-delivery'
import {
  useMarkupMode,
  type MarkupCaptureContext,
  type MarkupCompleteInput,
  type MarkupModeController
} from './useMarkupMode'
import type { BrowserRecorderStepDetail } from '../browser-recorder-types'
import type { BrowserRecorderPageContext } from '../useBrowserRecorder'
import { markupShapeToLog, resolveMarkupShapeElements } from './markup-element-resolution'

export type BrowserRecorderIntegration = {
  recordingRef: MutableRefObject<boolean>
  recordStep: (detail: BrowserRecorderStepDetail, page: BrowserRecorderPageContext) => void
  pageUrl: string
  pageTitle: string
}

export function useBrowserPageMarkupCapture(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  containerRef: MutableRefObject<HTMLDivElement | null>,
  recorder?: BrowserRecorderIntegration
): MarkupModeController {
  return useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const webview = webviewRef.current
      const container = containerRef.current
      if (!webview || !container) {
        return null
      }
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: { kind: 'webview', webview },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, [containerRef, webviewRef]),
    onDeliver: async (result) => {
      // Why: while recording, markup is logged as text (shapes + target
      // elements) instead of copied — the clipboard flow is skipped entirely.
      if (recorder?.recordingRef.current) {
        return
      }
      await deliverMarkupToClipboard(result)
    },
    // Why: log the markup as a completed step only after the composited image
    // reached the clipboard; a cancelled/failed session must not be recorded.
    onCompleted: async ({ shapes }: MarkupCompleteInput) => {
      if (!recorder?.recordingRef.current || shapes.length === 0) {
        return
      }
      const webview = webviewRef.current
      const shapeLogs = webview
        ? await resolveMarkupShapeElements(webview, shapes)
        : shapes.map(markupShapeToLog)
      recorder.recordStep(
        { kind: 'markup', shapes: shapeLogs },
        { pageUrl: recorder.pageUrl, pageTitle: recorder.pageTitle }
      )
    }
  })
}
