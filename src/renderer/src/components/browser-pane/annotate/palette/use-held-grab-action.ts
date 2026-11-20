import { useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'

/** Revalidate the original pick before acting, including the gap before a route-removal report arrives. */
export function useHeldGrabAction(
  payload: BrowserGrabPayload | null,
  pageId: string
): (action: () => void) => void {
  const livePayloadRef = useRef(payload)
  useLayoutEffect(() => {
    livePayloadRef.current = payload
  }, [payload])
  return (action) => {
    if (!payload) {
      return
    }
    void window.api.browser
      .grabPickedElementPresent({
        browserPageId: pageId,
        selectionId: payload.page.capturedAt,
        interactive: true
      })
      .then(
        (present) => {
          if (livePayloadRef.current !== payload) {
            return
          }
          if (present !== true) {
            if (present === null) {
              toast.error(translate('components.ui.dialog.tryAgain', 'Try again'))
            }
            return
          }
          action()
        },
        () => {
          if (livePayloadRef.current === payload) {
            toast.error(translate('components.ui.dialog.tryAgain', 'Try again'))
          }
        }
      )
  }
}
