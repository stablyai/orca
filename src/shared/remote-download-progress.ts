export type RemoteDownloadProgress = {
  downloadId: string
  transferredBytes: number
  /** Null when the size is not known up front, e.g. a folder walked lazily. */
  totalBytes: number | null
  completedFiles: number
}

export type RemoteDownloadTransferObserver = {
  signal?: AbortSignal
  onBytesTransferred?: (bytes: number) => void
  onFileCompleted?: () => void
}

export const REMOTE_DOWNLOAD_PROGRESS_INTERVAL_MS = 100

export type RemoteDownloadProgressTracker = {
  addBytes: (bytes: number) => void
  completeFile: () => void
  flush: () => void
}

export function createRemoteDownloadProgressTracker(args: {
  downloadId: string
  totalBytes: number | null
  emit: (progress: RemoteDownloadProgress) => void
  now?: () => number
}): RemoteDownloadProgressTracker {
  const now = args.now ?? Date.now
  let transferredBytes = 0
  let completedFiles = 0
  let lastEmittedAt = -Infinity
  let dirty = true

  const flush = (): void => {
    if (!dirty) {
      return
    }
    dirty = false
    lastEmittedAt = now()
    args.emit({
      downloadId: args.downloadId,
      transferredBytes,
      totalBytes: args.totalBytes,
      completedFiles
    })
  }
  // Why: fast links deliver thousands of chunks per second; forwarding each costs more IPC and
  // toast re-renders than the transfer itself.
  const flushIfDue = (): void => {
    if (now() - lastEmittedAt >= REMOTE_DOWNLOAD_PROGRESS_INTERVAL_MS) {
      flush()
    }
  }

  return {
    addBytes: (bytes) => {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return
      }
      transferredBytes += bytes
      dirty = true
      flushIfDue()
    },
    completeFile: () => {
      completedFiles += 1
      dirty = true
      flushIfDue()
    },
    flush
  }
}
