/**
 * Cancellation identity for workspace file-list scans (fs.listFiles).
 *
 * Why a dedicated error class: the readdir fallback wraps budget errors into
 * "install rg" guidance and Quick Open surfaces load errors verbatim, so a
 * cancelled scan must stay distinguishable from a genuine listing failure at
 * every layer (relay rg/git/readdir, main-process local scan, renderer).
 */
export class FileListingCancelledError extends Error {
  constructor(message = 'File listing cancelled') {
    super(message)
    this.name = 'FileListingCancelledError'
  }
}

/**
 * Build the rejection for an aborted scan, preferring the abort reason so a
 * superseded scan reports "superseded" rather than a generic cancellation.
 * Only FileListingCancelledError reasons pass through — a bare abort() sets
 * signal.reason to a DOMException that must not leak past the classifier.
 */
export function fileListingCancellationError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  if (reason instanceof FileListingCancelledError) {
    return reason
  }
  return new FileListingCancelledError()
}

export function isFileListingCancellation(error: unknown): boolean {
  return error instanceof FileListingCancelledError
}

export function throwIfFileListingCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw fileListingCancellationError(signal)
  }
}
