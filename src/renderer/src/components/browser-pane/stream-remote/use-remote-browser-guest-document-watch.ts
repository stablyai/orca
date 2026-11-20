import { useEffect, useLayoutEffect, useRef } from 'react'
import { subscribeRuntimeEnvironment } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-feature-interaction-source'
import {
  parseBrowserGuestDocumentEvent,
  type BrowserGuestDocumentEvent
} from '../../../../../shared/browser/annotations/browser-guest-document-event'

// A dropped watch resumes once the host is back, backing off while it stays away.
const RESUBSCRIBE_MIN_DELAY_MS = 1_000
const RESUBSCRIBE_MAX_DELAY_MS = 30_000

/** The streamed page's document events, which a local webview would deliver to its pane directly. */
export function useRemoteBrowserGuestDocumentWatch({
  enabled,
  environmentId,
  worktree,
  remotePageId,
  onEvent
}: {
  enabled: boolean
  environmentId: string
  worktree: string
  remotePageId: string | null
  onEvent: (event: BrowserGuestDocumentEvent) => void
}): void {
  const onEventRef = useRef(onEvent)
  useLayoutEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (!enabled || !remotePageId) {
      return
    }
    return watchRemoteBrowserGuestDocument({ environmentId, worktree, remotePageId }, (event) =>
      onEventRef.current(event)
    )
  }, [enabled, environmentId, remotePageId, worktree])
}

/** Keeps `browser.grab.watch` open for one page until the returned disposer runs. */
function watchRemoteBrowserGuestDocument(
  page: { environmentId: string; worktree: string; remotePageId: string },
  onEvent: (event: BrowserGuestDocumentEvent) => void
): () => void {
  let disposed = false
  let unsubscribe: (() => void) | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let retryDelay = RESUBSCRIBE_MIN_DELAY_MS
  const scheduleRetry = (): void => {
    if (disposed || retry !== null) {
      return
    }
    retry = setTimeout(subscribe, retryDelay)
    retryDelay = Math.min(retryDelay * 2, RESUBSCRIBE_MAX_DELAY_MS)
  }
  function subscribe(): void {
    retry = null
    void subscribeRuntimeEnvironment(
      {
        selector: page.environmentId,
        method: 'browser.grab.watch',
        params: withBrowserPaneUiRuntimeRpcSource({
          worktree: page.worktree,
          page: page.remotePageId
        }),
        timeoutMs: 15_000
      },
      {
        onResponse: (response) => {
          const event = response.ok ? parseBrowserGuestDocumentEvent(response.result) : null
          if (event && !disposed) {
            retryDelay = RESUBSCRIBE_MIN_DELAY_MS
            onEvent(event)
          }
        },
        onClose: () => {
          unsubscribe = null
          if (!disposed) {
            onEvent({ type: 'documentStart' })
          }
          scheduleRetry()
        }
      }
    )
      .then((subscription) => {
        if (disposed) {
          subscription.unsubscribe()
        } else {
          unsubscribe = subscription.unsubscribe
        }
      })
      .catch(scheduleRetry)
  }
  subscribe()
  return () => {
    disposed = true
    if (retry !== null) {
      clearTimeout(retry)
    }
    unsubscribe?.()
  }
}
