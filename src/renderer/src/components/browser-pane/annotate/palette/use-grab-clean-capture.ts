import { useCallback, useRef } from 'react'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'

type CleanCaptureRequest = { pageId: string; requestId: string }
type PendingCleanCapture = { current: CleanCaptureRequest | null }

async function settleCleanCapture(
  request: CleanCaptureRequest,
  pending: PendingCleanCapture
): Promise<boolean> {
  try {
    const result = await window.api.browser.setGrabMode({
      browserPageId: request.pageId,
      enabled: false,
      requestId: request.requestId
    })
    return pending.current === request && result.ok && result.clean === true
  } catch {
    return false
  } finally {
    if (pending.current === request) {
      pending.current = null
    }
  }
}

/** Cancellation targets this exact request, including while it waits for the guest to load. */
export function useGrabCleanCapture(): {
  waitForCleanPage: (pageId: string) => Promise<boolean>
  cancelClean: () => void
} {
  const pending = useRef<CleanCaptureRequest | null>(null)
  const cancelClean = useCallback(() => {
    const request = pending.current
    pending.current = null
    if (request) {
      void window.api.browser
        .cancelGrab({
          browserPageId: request.pageId,
          requestId: request.requestId
        })
        .catch(() => {})
    }
  }, [])
  const waitForCleanPage = useCallback(
    (pageId: string): Promise<boolean> => {
      cancelClean()
      const request = { pageId, requestId: `draw-clean-${createNonSecureContextUuid()}` }
      pending.current = request
      return settleCleanCapture(request, pending)
    },
    [cancelClean]
  )
  return { waitForCleanPage, cancelClean }
}
