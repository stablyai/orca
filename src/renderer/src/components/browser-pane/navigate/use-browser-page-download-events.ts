import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent
} from '../../../../../shared/browser-guest-events'
import type { BrowserDownloadState } from './browser-download-progress'

export function useBrowserPageDownloadEvents({
  browserTabId,
  setResourceNotice
}: {
  browserTabId: string
  setResourceNotice: Dispatch<SetStateAction<string | null>>
}): {
  downloadStates: BrowserDownloadState[]
  setDownloadStates: Dispatch<SetStateAction<BrowserDownloadState[]>>
} {
  const [downloadStates, setDownloadStates] = useState<BrowserDownloadState[]>([])

  useEffect(() => {
    return window.api.browser.onDownloadRequested((event) => {
      if (event.browserPageId !== browserTabId) {
        return
      }
      setDownloadStates((current) => {
        const nextEntry: BrowserDownloadState = {
          browserPageId: event.browserPageId,
          downloadId: event.downloadId,
          origin: event.origin,
          filename: event.filename,
          totalBytes: event.totalBytes,
          mimeType: event.mimeType,
          receivedBytes: 0,
          status: 'downloading',
          savePath: event.savePath,
          error: null,
          progressState: null,
          completedAt: null
        }
        const existingIndex = current.findIndex(
          (download) => download.downloadId === event.downloadId
        )
        if (existingIndex === -1) {
          return [nextEntry, ...current]
        }
        const next = [...current]
        next[existingIndex] = { ...next[existingIndex], ...nextEntry }
        return next
      })
      setResourceNotice(null)
    })
  }, [browserTabId, setResourceNotice])

  useEffect(() => {
    return window.api.browser.onDownloadProgress((event: BrowserDownloadProgressEvent) => {
      setDownloadStates((current) =>
        current.map((download) =>
          download.downloadId === event.downloadId
            ? {
                ...download,
                receivedBytes: event.receivedBytes,
                totalBytes: event.totalBytes,
                progressState: event.state
              }
            : download
        )
      )
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onDownloadFinished((event: BrowserDownloadFinishedEvent) => {
      if (event.browserPageId && event.browserPageId !== browserTabId) {
        return
      }
      setDownloadStates((current) =>
        current.map((download) =>
          download.downloadId === event.downloadId
            ? {
                ...download,
                status: event.status,
                savePath: event.savePath,
                error: event.error,
                completedAt: Date.now()
              }
            : download
        )
      )
    })
  }, [browserTabId])

  return { downloadStates, setDownloadStates }
}
