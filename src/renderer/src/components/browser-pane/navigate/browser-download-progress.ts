import type {
  BrowserDownloadRequestedEvent,
  BrowserDownloadProgressEvent
} from '../../../../../shared/browser-guest-events'
import { formatByteCount } from './browser-notices'

export type BrowserDownloadState = Omit<BrowserDownloadRequestedEvent, 'status' | 'savePath'> & {
  receivedBytes: number
  status: 'downloading' | 'completed' | 'failed' | 'canceled'
  savePath: string | null
  error: string | null
  progressState: BrowserDownloadProgressEvent['state']
  completedAt: number | null
}

export function formatBrowserDownloadProgress(download: BrowserDownloadState): string | null {
  const received = formatByteCount(download.receivedBytes)
  const total = formatByteCount(download.totalBytes)
  if (received && total) {
    return `${received} / ${total}`
  }
  return received ?? total
}
