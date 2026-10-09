import type {
  StagedRuntimeUploadEntry,
  StagedRuntimeUploadSource
} from './runtime-upload-staging-contract'

export type ImportSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

export type ResolveDroppedPathsResult = {
  resolvedPaths: string[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  /** `cancelled` marks a source the user's cancel stopped, so it is not reported as an error. */
  failed: { sourcePath: string; reason: string; cancelled?: boolean }[]
}

export type ImportItemResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
      renamed: boolean
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
      /** The user cancelled this source, so it is not a failure to report back. */
      cancelled?: boolean
    }

// Why: staging crosses IPC to the renderer and back into the streamer, so the
// shape lives in shared and every layer names the same type.
export type StagedExternalImportSource = StagedRuntimeUploadSource
export type StagedExternalImportEntry = StagedRuntimeUploadEntry
