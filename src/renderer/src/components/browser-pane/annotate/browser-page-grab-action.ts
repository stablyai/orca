import type { MutableRefObject } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabScreenshot
} from '../../../../../shared/browser-grab-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'
import type { BrowserPageGrabToastState, GrabIntent } from '../describe-page/browser-page-types'

export function runBrowserGrabActionShortcut({
  key,
  grabIntent,
  grab,
  grabPayloadRef,
  toolTargetIdRef,
  recordFeatureInteraction,
  showGrabToast
}: {
  key: 'c' | 's'
  grabIntent: GrabIntent
  grab: GrabModeHook
  grabPayloadRef: MutableRefObject<BrowserGrabPayload | null>
  toolTargetIdRef: MutableRefObject<string>
  recordFeatureInteraction: (feature: 'browser-grab') => void | Promise<void>
  showGrabToast: (
    message: string,
    type: BrowserPageGrabToastState['type'],
    payload?: BrowserGrabPayload | null
  ) => void
}): void {
  if (grabIntent === 'annotate') {
    return
  }
  const copyFromPayload = (payload: BrowserGrabPayload): void => {
    if (key === 'c') {
      const text = formatGrabPayloadAsText(payload)
      void window.api.ui.writeClipboardText(text)
      recordFeatureInteraction('browser-grab')
      showGrabToast('Copied', 'success', payload)
    } else {
      const dataUrl = payload.screenshot?.dataUrl
      if (dataUrl?.startsWith('data:image/png;base64,')) {
        void window.api.ui.writeClipboardImage(dataUrl)
        recordFeatureInteraction('browser-grab')
        showGrabToast('Screenshotted', 'success', payload)
      } else {
        showGrabToast('No screenshot available', 'error', payload)
      }
    }
  }

  if (grab.state === 'confirming') {
    // Why: right-click (contextMenu) skips the left-click auto-copy, so C must still work here.
    if (grab.contextMenu && key === 'c') {
      const currentPayload = grabPayloadRef.current
      if (currentPayload) {
        copyFromPayload(currentPayload)
      }
      grab.rearm()
    } else if (key === 's') {
      const currentPayload = grabPayloadRef.current
      if (currentPayload) {
        copyFromPayload(currentPayload)
      }
      grab.rearm()
    }
  } else {
    // armed/awaiting — extract hovered element via IPC without clicking
    void (async () => {
      let result: Awaited<ReturnType<typeof window.api.browser.extractHoverPayload>>
      try {
        result = await window.api.browser.extractHoverPayload({
          browserPageId: toolTargetIdRef.current
        })
      } catch {
        // Why: the guest can be destroyed or the IPC channel torn down mid-shortcut; surface it like a miss instead of an unhandled rejection.
        showGrabToast('Could not read the hovered element', 'error')
        return
      }
      if (!result.ok) {
        showGrabToast('No element hovered', 'error')
        return
      }
      const payload = result.payload as BrowserGrabPayload

      if (key === 's') {
        try {
          const ssResult = await window.api.browser.captureSelectionScreenshot({
            browserPageId: toolTargetIdRef.current,
            rect: payload.target.rectViewport
          })
          if (ssResult.ok) {
            payload.screenshot = ssResult.screenshot as BrowserGrabScreenshot
          }
        } catch {
          // Screenshot failure is non-fatal for the copy flow
        }
      }

      copyFromPayload(payload)
    })()
  }
}
