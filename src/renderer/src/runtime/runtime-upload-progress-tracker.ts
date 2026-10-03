import {
  isUploadCancelledReason,
  UPLOAD_CANCELLED_REASON
} from '../../../shared/ssh-import-cancel-reason'

export type RuntimeUploadProgressReport = { sentBytes: number; totalBytes: number }

export type RuntimeUploadProgressTracker = {
  /** Opens the window in which progress for the next file is accepted. */
  beginFile: (fileSequence: number) => void
  /** Bytes of the file in flight; an event without this file's sequence is dropped. */
  reportFileProgress: (sentBytes: number, fileSequence: number | undefined) => void
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
  // Why: a late event from the previous file can also land after the next file's
  // beginFile; the sequence main echoes back tells the two apart.
  let currentFileSequence: number | undefined

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
    beginFile: (fileSequence) => {
      acceptingProgress = true
      currentFileSequence = fileSequence
      inFlightBytes = 0
    },
    reportFileProgress: (sentBytes, fileSequence) => {
      if (!acceptingProgress) {
        return
      }
      if (fileSequence === undefined || fileSequence !== currentFileSequence) {
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
  kind?: 'file' | 'directory'
}

export type RuntimeImportProgressHandlers = {
  onStart: (rows: RuntimeImportProgressRow[]) => void
  /** totalBytes and kind arrive with SSH progress, which learns them only once the source starts. */
  onRowProgress: (
    uploadId: string,
    sentBytes: number,
    totalBytes?: number,
    kind?: 'file' | 'directory'
  ) => void
  /** `detail` carries what a cancel could not undo, e.g. a partial upload left on the host. */
  onRowSettled: (uploadId: string, status: 'done' | 'failed', detail?: string) => void
  onFinish: () => void
  /** Lets the import stop a source the user cancelled before it streams any file. */
  isCancelled?: (uploadId: string) => boolean
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

/** The user's cancel is what stopped this source, not a failure that came after the click. */
export function wasStoppedByCancel(
  handlers: RuntimeImportProgressHandlers | undefined,
  uploadId: string | undefined,
  reason: string
): boolean {
  return (
    uploadId !== undefined &&
    handlers?.isCancelled?.(uploadId) === true &&
    isUploadCancelledReason(reason)
  )
}

/** Throws the cancel reason once the user cancelled this source's row. */
export function stopIfCancelled(
  handlers: RuntimeImportProgressHandlers | undefined,
  uploadId: string | undefined
): void {
  if (uploadId !== undefined && handlers?.isCancelled?.(uploadId) === true) {
    throw new Error(UPLOAD_CANCELLED_REASON)
  }
}
