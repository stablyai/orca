import { measureClipboardTextByteLength } from './clipboard-text'

export const ORCA_INTERNAL_FILE_DRAG_TYPE = 'text/x-orca-file-path'

export const NATIVE_FILE_DROP_MAX_PATHS = 256
export const NATIVE_FILE_DROP_MAX_PATH_BYTES = 256 * 1024

export type NativeFileDropRejectedPayload = {
  byteLength: number
  pathCount: number
  reason: NativeFileDropRejectionReason
  target: 'rejected'
  /** Why every file in a `temp-copy-failed` drop went uncopied, when they share one reason. */
  commonReason?: NativeFileDropCopyFailureReason
}

// Why tokens: the renderer owns the localized copy; main never sends display text.
export const NATIVE_FILE_DROP_COPY_FAILURE_REASONS = [
  'missing',
  'permission-denied',
  'changed',
  'out-of-space',
  'storage-unavailable',
  'storage-not-private',
  'copy-failed',
  'timed-out',
  'busy',
  // Too big to copy, so agents in terminals and composers can't be given it.
  'too-large',
  'storage-full'
] as const

export type NativeFileDropCopyFailureReason = (typeof NATIVE_FILE_DROP_COPY_FAILURE_REASONS)[number]

/** What path validation alone can reject a drop for. */
export type NativeFileDropSizeRejectionReason = 'paths-too-large' | 'too-many-paths'

/** `unresolved-paths`: the OS handed us file items no path could be read from
 *  (promised/virtual files), which used to be swallowed with no feedback.
 *  `temp-copy-failed`: main could not copy a macOS drag-temp file; only main sends it. */
export type NativeFileDropRejectionReason =
  | NativeFileDropSizeRejectionReason
  | 'unresolved-paths'
  | 'temp-copy-failed'

export type NativeFileDropPathValidation =
  | { byteLength: number; pathCount: number; status: 'accepted' }
  | {
      byteLength: number
      pathCount: number
      reason: NativeFileDropSizeRejectionReason
      status: 'rejected'
    }

function getDataTransferTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): string[] {
  return types ? Array.from(types) : []
}

export function hasNativeFileDragTypes(
  types: Iterable<string> | ArrayLike<string> | null | undefined
): boolean {
  const values = getDataTransferTypes(types)
  return values.includes('Files') && !values.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)
}

export function validateNativeFileDropPaths(
  paths: readonly string[],
  options: {
    maxPathBytes?: number
    maxPaths?: number
  } = {}
): NativeFileDropPathValidation {
  const pathCount = paths.length
  const maxPaths = options.maxPaths ?? NATIVE_FILE_DROP_MAX_PATHS
  if (pathCount > maxPaths) {
    return {
      byteLength: 0,
      pathCount,
      reason: 'too-many-paths',
      status: 'rejected'
    }
  }

  const maxPathBytes = options.maxPathBytes ?? NATIVE_FILE_DROP_MAX_PATH_BYTES
  let byteLength = 0
  for (const path of paths) {
    const measurement = measureClipboardTextByteLength(path, {
      stopAfterBytes: maxPathBytes - byteLength
    })
    byteLength += measurement.byteLength
    if (byteLength > maxPathBytes) {
      return {
        byteLength,
        pathCount,
        reason: 'paths-too-large',
        status: 'rejected'
      }
    }
  }

  return { byteLength, pathCount, status: 'accepted' }
}

export function createRejectedNativeFileDropPayload(
  validation: Extract<NativeFileDropPathValidation, { status: 'rejected' }>
): NativeFileDropRejectedPayload {
  return {
    byteLength: validation.byteLength,
    pathCount: validation.pathCount,
    reason: validation.reason,
    target: 'rejected'
  }
}
