import type { MutableRefObject } from 'react'
import type {
  BrowserGrabPayload,
  BrowserGrabScreenshot,
  GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'
import type { BrowserPageGrabToastState } from '../../describe-page/browser-page-types'
import { translate } from '@/i18n/i18n'

/** Snapshot of the picker's target at action start; true while the same Grab session on the same page is on. */
export function grabHoverStillCurrent(
  sessionRef: MutableRefObject<number>,
  mountedRef: MutableRefObject<boolean>
): () => boolean {
  // The session number moves on every exit, intent change and page change, so leaving and re-entering Grab
  // while a read is in flight (A→B→A) still counts as stale.
  const startedSession = sessionRef.current
  return () => mountedRef.current && sessionRef.current === startedSession
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
  const operationToken = grab.getOperationToken()
  const toolTargetId = toolTargetIdRef.current
  const copyFromPayload = (payload: BrowserGrabPayload): void => {
    if (!grab.isCurrentOperationToken(operationToken)) {
      return
    }
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
    if (!(grab.contextMenu && key === 'c') && key !== 's') {
      return
    }
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    void grab.transport
      .grabPickedElementPresent({
        browserPageId: toolTargetId,
        selectionId: payload.page.selectionId ?? payload.page.capturedAt,
        interactive: true
      })
      .then((present) => {
        if (!isStillCurrent() || grabPayloadRef.current !== payload) {
          return
        }
        if (present !== true) {
          if (present === false) {
            grab.cancel()
          }
          if (present === null) {
            showGrabToast(translate('components.ui.dialog.tryAgain', 'Try again'), 'error', payload)
          }
          return
        }
        copyFromPayload(payload)
        grab.rearm()
      })
      .catch(() => {
        if (isStillCurrent()) {
          showGrabToast(translate('components.ui.dialog.tryAgain', 'Try again'), 'error', payload)
        }
      })
  } else {
    // armed/awaiting — extract hovered element via IPC without clicking
    void (async () => {
      let result: Awaited<ReturnType<typeof grab.transport.extractHoverPayload>>
      try {
        result = await grab.transport.extractHoverPayload({
          browserPageId: toolTargetId
        })
      } catch {
        // Why: the guest can be destroyed or the IPC channel torn down mid-shortcut; surface it like a miss instead of an unhandled rejection.
        if (isStillCurrent()) {
          showGrabToast('Could not read the hovered element', 'error')
        }
        return
      }
      if (!isStillCurrent() || !grab.isCurrentOperationToken(operationToken)) {
        return
      }
      if (!result.ok) {
        showGrabToast('No element hovered', 'error')
        return
      }
      const payload = result.payload as BrowserGrabPayload

      if (key === 's') {
        try {
          const ssResult = await grab.transport.captureSelectionScreenshot({
            browserPageId: toolTargetId,
            rect: payload.target.rectViewport,
            selectionId: payload.page.selectionId
          })
          if (ssResult.ok) {
            payload.screenshot = ssResult.screenshot as BrowserGrabScreenshot
          }
        } catch {
          // Screenshot failure is non-fatal for the copy flow
        }
        if (!isStillCurrent() || !grab.isCurrentOperationToken(operationToken)) {
          return
        }
      }

      copyFromPayload(payload)
    })()
  }
}
