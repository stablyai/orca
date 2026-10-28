/** Keep cancellation distinct through relay/main/renderer: readdir wraps budget failures as install-rg guidance, and Quick Open displays load errors verbatim. */
export class FileListingCancelledError extends Error {
  constructor(message = 'File listing cancelled') {
    super(message)
    this.name = 'FileListingCancelledError'
  }
}

/** Preserve FileListingCancelledError reasons such as superseded; bare abort’s DOMException must not escape the cancellation classifier. */
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
