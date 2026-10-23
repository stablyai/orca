import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isClientHostedBrowserPageHandle } from '@/store/slices/browser'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent
} from '../../../../shared/browser-guest-events'
import { formatBrowserRemoteDownloadMessage } from './browser-download-destination-toast'
import { formatByteCount } from './navigate/browser-notices'

/** One toast per download, so progress, completion and failure replace each other in place. */
function downloadToastId(downloadId: string): string {
  return `browser-download:${downloadId}`
}

/**
 * A client-hosted page has no download shelf and its bytes never land in this desktop's Downloads
 * folder, so these toasts are the only signal that a download started, landed on the remote
 * workspace, or was refused.
 *
 * Why app-level: the page's pane unmounts on a page switch or close while the download keeps
 * running, and a loading toast whose finish nobody hears has no close button and never expires.
 */
export function useBrowserClientHostedDownloadNotices(): void {
  useEffect(() => {
    // Claimed at request time: the finish can arrive after the page's handle is gone.
    const filenames = new Map<string, string>()
    const releaseRequested = window.api.browser.onDownloadRequested(
      (event: BrowserDownloadRequestedEvent) => {
        const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId[event.browserPageId]
        if (!handle || !isClientHostedBrowserPageHandle(handle)) {
          return
        }
        filenames.set(event.downloadId, event.filename)
        toast.loading(
          translate('browser.clientHosted.download.started', 'Downloading {{filename}}…', {
            filename: event.filename
          }),
          { id: downloadToastId(event.downloadId) }
        )
      }
    )
    const releaseProgress = window.api.browser.onDownloadProgress(
      (event: BrowserDownloadProgressEvent) => {
        const filename = filenames.get(event.downloadId)
        if (filename === undefined) {
          return
        }
        toast.loading(formatBrowserClientHostedDownloadProgress(event, filename), {
          id: downloadToastId(event.downloadId)
        })
      }
    )
    const releaseFinished = window.api.browser.onDownloadFinished(
      (event: BrowserDownloadFinishedEvent) => {
        const filename = filenames.get(event.downloadId)
        if (filename === undefined) {
          return
        }
        filenames.delete(event.downloadId)
        emitBrowserClientHostedDownloadNotice(event, filename)
      }
    )
    return () => {
      releaseRequested()
      releaseProgress()
      releaseFinished()
    }
  }, [])
}

/** "Downloading report.pdf… 2.1 MB / 8 MB", falling back to the plain line when size is unknown. */
export function formatBrowserClientHostedDownloadProgress(
  event: Pick<BrowserDownloadProgressEvent, 'receivedBytes' | 'totalBytes'>,
  filename: string
): string {
  const started = translate('browser.clientHosted.download.started', 'Downloading {{filename}}…', {
    filename
  })
  const received = formatByteCount(event.receivedBytes)
  const total = formatByteCount(event.totalBytes)
  if (received && total) {
    return `${started} ${received} / ${total}`
  }
  return received ? `${started} ${received}` : started
}

export function emitBrowserClientHostedDownloadNotice(
  event: BrowserDownloadFinishedEvent,
  filename: string
): void {
  const id = downloadToastId(event.downloadId)
  if (event.status === 'completed') {
    toast.success(
      event.remoteDestination
        ? formatBrowserRemoteDownloadMessage(event.remoteDestination)
        : translate('browser.clientHosted.download.completed', 'Downloaded {{filename}}', {
            filename
          }),
      { id }
    )
    return
  }
  toast.error(
    event.error ||
      (event.status === 'canceled'
        ? translate('browser.clientHosted.download.canceled', 'Download canceled.')
        : translate('browser.clientHosted.download.failed', "Couldn't finish the download.")),
    { id }
  )
}
