import type { MutableRefObject } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabScreenshot,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'
import type { BrowserPageGrabToastState } from '../../describe-page/browser-page-types'

/** Snapshot of the picker's target at action start; true while the same Grab session on the same page is on. */
export function grabHoverStillCurrent(
  grabRef: MutableRefObject<Pick<GrabModeHook, 'state'>>,
  grabIntentRef: MutableRefObject<GrabIntent>,
  toolTargetIdRef: MutableRefObject<string>
): () => boolean {
  const startedTarget = toolTargetIdRef.current
  return () =>
    grabRef.current.state !== 'idle' &&
    grabIntentRef.current === 'copy' &&
    toolTargetIdRef.current === startedTarget
}

export function runBrowserGrabActionShortcut({
  key,
  grabIntent,
  grab,
  grabPayloadRef,
  toolTargetIdRef,
  recordFeatureInteraction,
  showGrabToast,
  copyGrabScreenshot,
  isStillCurrent = () => true
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
  copyGrabScreenshot: (dataUrl: string, payload: BrowserGrabPayload) => void
  /** False once the user left Grab or the page changed; a late hover result is then dropped. */
  isStillCurrent?: () => boolean
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
        recordFeatureInteraction('browser-grab')
        copyGrabScreenshot(dataUrl, payload)
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
      if (!isStillCurrent()) {
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
        if (!isStillCurrent()) {
          return
        }
      }

      copyFromPayload(payload)
    })()
  }
}
