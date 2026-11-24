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

/**
 * Draw's whole wait for main, from before its clean is admitted (which waits for the page's load)
 * through the readback: the bound Draw had when it captured in the renderer.
 */
export const DRAW_CAPTURE_DEADLINE_MS = 10_000

async function captureCleanRequest(
  request: CleanCaptureRequest,
  pending: PendingCleanCapture
): Promise<MarkupBaseImage> {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve(null)
    }, DRAW_CAPTURE_DEADLINE_MS)
  })
  try {
    const capture = await Promise.race([
      window.api.browser.captureCleanPage({
        browserPageId: request.pageId,
        requestId: request.requestId
      }),
      deadline
    ])
    if (expired) {
      // Retire this exact request in main, so it never captures or opens after Draw gave up; the
      // page's own load is left alone.
      if (pending.current === request) {
        pending.current = null
        void window.api.browser
          .cancelGrab({ browserPageId: request.pageId, requestId: request.requestId })
          .catch(() => {})
      }
      throw new Error('markup: the clean page capture timed out')
    }
    if (!capture || pending.current !== request) {
      throw new Error('markup: the clean page capture was superseded')
    }
    return await flattenCapturedPage(capture)
  } finally {
    clearTimeout(timer)
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
    (pageId: string): Promise<MarkupBaseImage> => captureCleanRequest(begin(pageId), pending),
    [begin]
  )
  return { waitForCleanPage, captureCleanPage, cancelClean }
}
