import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isBrowserClientPageFreed,
  wakeBrowserClientPage
} from '../../host-guest/client-pages/browser-client-page-renderer-installation'
import { whenBrowserClientPageContainerShown } from '../../host-guest/client-pages/browser-client-page-paint-retention'
import type { ClientHostedBrowserPagePaneProps } from '../../describe-page/browser-page-types'

/** A pane's attach failures, and the This-device page Memory Saver freed that comes back on view. */
export function useClientHostedPageAttachment(
  browserPageId: string,
  onUpdatePageState: ClientHostedBrowserPagePaneProps['onUpdatePageState']
) {
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  // Bumped when a freed page is mounted again, so the pane attaches once more.
  const [remountRevision, setRemountRevision] = useState(0)
  const retryGuestRecoveryRef = useRef<() => void>(() => {})
  const stopWakeRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    retryGuestRecoveryRef.current = () => {
      onUpdatePageState(browserPageId, { loading: false })
      setAttachmentError('browser_client_page_guest_unavailable')
    }
  }, [browserPageId, onUpdatePageState])
  useEffect(() => () => stopWakeRef.current(), [])
  // The pane's successful attach ends any wait a lost guest left, so it can't report a stale failure.
  const setPaneAttachmentError = useCallback((error: string | null): void => {
    if (error === null) {
      stopWakeRef.current()
    }
    setAttachmentError(error)
  }, [])

  /** A missing page may be one Memory Saver freed: once the pane shows, main remakes it. */
  const wakeWhenShown = useCallback(
    (container: HTMLElement, pageHostGeneration: number, code: string): (() => void) => {
      stopWakeRef.current()
      if (code !== 'browser_client_page_renderer_visible_page_unavailable') {
        setAttachmentError(code)
        return () => {}
      }
      let stop = whenBrowserClientPageContainerShown(container, () => {
        stop = wakeBrowserClientPage(
          { browserPageId, pageHostGeneration },
          () => setRemountRevision((revision) => revision + 1),
          () => setAttachmentError(code)
        )
      })
      stopWakeRef.current = () => stop()
      return stopWakeRef.current
    },
    [browserPageId]
  )
  // A guest Memory Saver freed is not a failure: it comes back when the pane is next shown.
  const recoverLostGuest = useCallback(
    (container: HTMLElement, pageHostGeneration: number): void => {
      if (isBrowserClientPageFreed(browserPageId)) {
        wakeWhenShown(
          container,
          pageHostGeneration,
          'browser_client_page_renderer_visible_page_unavailable'
        )
      } else {
        retryGuestRecoveryRef.current()
      }
    },
    [browserPageId, wakeWhenShown]
  )
  return {
    attachmentError,
    setAttachmentError: setPaneAttachmentError,
    remountRevision,
    retryGuestRecoveryRef,
    wakeWhenShown,
    recoverLostGuest
  }
}
