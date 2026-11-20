import { useLayoutEffect, useRef, type MutableRefObject } from 'react'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'

/** Revalidate the original pick before acting, including the gap before a route-removal report arrives. */
export function useHeldGrabAction(
  payload: BrowserGrabPayload | null,
  pageId: string,
  menuActionTakenRef: MutableRefObject<boolean>
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
      .grabPickedElementPresent({ browserPageId: pageId, selectionId: payload.page.capturedAt })
      .then(
        (present) => {
          if (!present || livePayloadRef.current !== payload) {
            return
          }
          action()
          menuActionTakenRef.current = false
        },
        () => {}
      )
  }
}
