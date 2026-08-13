export type CursorSidecarScanCancellation = {
  throwIfCancelled: () => void
}

export function isCursorSidecarScanCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === 'cursor_sidecar_scan_cancelled'
}

export function cursorSidecarScanCancellationFromSignal(
  signal?: AbortSignal
): CursorSidecarScanCancellation {
  return {
    throwIfCancelled: () => {
      if (signal?.aborted) {
        throw new Error('cursor_sidecar_scan_cancelled')
      }
    }
  }
}
