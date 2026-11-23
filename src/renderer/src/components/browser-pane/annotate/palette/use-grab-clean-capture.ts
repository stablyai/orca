import { useCallback, useRef } from 'react'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { flattenCapturedPage, type MarkupBaseImage } from '../capture/markup-base-image'

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
  /** Removes the picker again and captures that same document in one step main serializes with arming. */
  captureCleanPage: (pageId: string) => Promise<MarkupBaseImage>
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
  const begin = useCallback(
    (pageId: string): CleanCaptureRequest => {
      cancelClean()
      const request = { pageId, requestId: `draw-clean-${createNonSecureContextUuid()}` }
      pending.current = request
      return request
    },
    [cancelClean]
  )
  const waitForCleanPage = useCallback(
    (pageId: string): Promise<boolean> => settleCleanCapture(begin(pageId), pending),
    [begin]
  )
  const captureCleanPage = useCallback(
    async (pageId: string): Promise<MarkupBaseImage> => {
      const request = begin(pageId)
      try {
        const capture = await window.api.browser.captureCleanPage({
          browserPageId: request.pageId,
          requestId: request.requestId
        })
        if (!capture || pending.current !== request) {
          throw new Error('markup: the clean page capture was superseded')
        }
        return await flattenCapturedPage(capture)
      } finally {
        if (pending.current === request) {
          pending.current = null
        }
      }
    },
    [begin]
  )
  return { waitForCleanPage, captureCleanPage, cancelClean }
}
