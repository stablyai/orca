import { useCallback, type MutableRefObject } from 'react'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserPageGrabToastState } from '../../describe-page/browser-page-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'

/**
 * Copy and Screenshot for a pick: the picker's current one (right-click menu), or one the annotate palette still
 * holds after the picker rearmed. Only a pick the picker is still showing is rearmed afterwards.
 */
export function useGrabCopyHandlers({
  grab,
  grabPayloadRef,
  grabMenuActionTakenRef,
  recordFeatureInteraction,
  showGrabToast,
  showGrabScreenshotToast,
  copyGrabScreenshot,
  copiedMessage
}: {
  grab: GrabModeHook
  grabPayloadRef: MutableRefObject<BrowserGrabPayload | null>
  grabMenuActionTakenRef: MutableRefObject<boolean>
  recordFeatureInteraction: (feature: 'browser-grab') => void | Promise<void>
  showGrabToast: (
    message: string,
    type: BrowserPageGrabToastState['type'],
    payload?: BrowserGrabPayload | null
  ) => void
  showGrabScreenshotToast: (copied: boolean, payload: BrowserGrabPayload) => void
  copyGrabScreenshot: (dataUrl: string, onDone: (copied: boolean) => void) => void
  copiedMessage: () => string
}): {
  handleGrabCopy: (held?: BrowserGrabPayload) => void
  handleGrabCopyScreenshot: (held?: BrowserGrabPayload) => void
} {
  const handleGrabCopy = useCallback(
    (held?: BrowserGrabPayload) => {
      grabMenuActionTakenRef.current = true
      const payload = held ?? grabPayloadRef.current
      if (!payload) {
        return
      }
      void window.api.ui.writeClipboardText(formatGrabPayloadAsText(payload))
      recordFeatureInteraction('browser-grab')
      showGrabToast(copiedMessage(), 'success', payload)
      if (grab.state === 'confirming') {
        grab.rearm()
      }
    },
    [
      copiedMessage,
      grab,
      grabMenuActionTakenRef,
      grabPayloadRef,
      recordFeatureInteraction,
      showGrabToast
    ]
  )

  const handleGrabCopyScreenshot = useCallback(
    (held?: BrowserGrabPayload) => {
      grabMenuActionTakenRef.current = true
      const payload = held ?? grabPayloadRef.current
      const dataUrl = payload?.screenshot?.dataUrl
      if (!payload || !dataUrl?.startsWith('data:image/png;base64,')) {
        return
      }
      recordFeatureInteraction('browser-grab')
      copyGrabScreenshot(dataUrl, (copied) => showGrabScreenshotToast(copied, payload))
      if (grab.state === 'confirming') {
        grab.rearm()
      }
    },
    [
      copyGrabScreenshot,
      grab,
      grabMenuActionTakenRef,
      grabPayloadRef,
      recordFeatureInteraction,
      showGrabScreenshotToast
    ]
  )

  return { handleGrabCopy, handleGrabCopyScreenshot }
}
