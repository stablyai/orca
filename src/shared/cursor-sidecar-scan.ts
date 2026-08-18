export const CURSOR_SIDECAR_MAX_BYTES = 262_144
export const CURSOR_SIDECAR_MAX_AGGREGATE_BYTES = 16_777_216
export const CURSOR_SIDECAR_MAX_BUCKETS = 256
export const CURSOR_SIDECAR_MAX_SCOPE_PATHS = 64
export const CURSOR_SIDECAR_MAX_SESSION_DIRS = 2_000
export const CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED = 8_192

export type CursorSidecarScanCounters = {
  rootReaddir: number
  bucketReaddir: number
  direntsRead: number
  fileLstat: number
  boundedReads: number
  scopeRealpath: number
  returnedBytes: number
  elapsedMs: number
}

export type CursorSidecarScanTruncation = {
  scopePaths: boolean
  buckets: boolean
  sessionDirs: boolean
  sidecarBytes: boolean
}

export type CursorSidecarScanState = {
  issues: { path: string; message: string }[]
  counters: CursorSidecarScanCounters
  truncated: CursorSidecarScanTruncation
}
