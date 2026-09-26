export type RuntimeUploadProgressReport = { sentBytes: number; totalBytes: number }

export type RuntimeUploadProgressTracker = {
  /** Opens the window in which progress for the next file is accepted. */
  beginFile: () => void
  /** Bytes of the file currently in flight that have reached the runtime. */
  reportFileProgress: (sentBytes: number) => void
  /** Called once a file is committed, so its bytes move from in-flight to done. */
  completeFile: (byteLength: number) => void
}

/** Committed files plus the one in flight; uploads are strictly sequential. */
export function createRuntimeUploadProgressTracker(
  totalBytes: number,
  report: (progress: RuntimeUploadProgressReport) => void
): RuntimeUploadProgressTracker {
  let completedBytes = 0
  let inFlightBytes = 0
  let lastReported = -1
  // Electron does not order webContents.send against an invoke reply, so a final
  // progress event can land after completeFile and be counted twice.
  let acceptingProgress = false

  const emit = (): void => {
    // Why: a source can grow between staging and upload, so the sum of what
    // actually moved may exceed the total staging measured.
    const sentBytes = Math.min(completedBytes + inFlightBytes, totalBytes)
    if (sentBytes === lastReported) {
      return
    }
    lastReported = sentBytes
    report({ sentBytes, totalBytes })
  }

  return {
    beginFile: () => {
      acceptingProgress = true
      inFlightBytes = 0
    },
    reportFileProgress: (sentBytes) => {
      if (!acceptingProgress) {
        return
      }
      inFlightBytes = sentBytes
      emit()
    },
    completeFile: (byteLength) => {
      acceptingProgress = false
      completedBytes += byteLength
      inFlightBytes = 0
      emit()
    }
  }
}

/** One row in the drop UI: everything the user dropped becomes exactly one. */
export type RuntimeImportProgressRow = {
  uploadId: string
  name: string
  totalBytes: number
  sourcePath: string
}

export type RuntimeImportProgressHandlers = {
  onStart: (rows: RuntimeImportProgressRow[]) => void
  onRowProgress: (uploadId: string, sentBytes: number) => void
  onRowSettled: (uploadId: string, status: 'done' | 'failed') => void
  onFinish: () => void
}

/** Bytes one dropped source will move; directory entries contribute nothing. */
export function sumSourceUploadBytes(source: {
  entries?: { kind: string; byteLength?: number }[]
}): number {
  let total = 0
  for (const entry of source.entries ?? []) {
    if (entry.kind === 'file') {
      total += entry.byteLength ?? 0
    }
  }
  return total
}
