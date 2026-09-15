import type {
  StagedRuntimeUploadEntry,
  StagedRuntimeUploadSource
} from './runtime-upload-staging-contract'

export type ImportSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

export type ResolveDroppedPathsResult = {
  resolvedPaths: string[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  failed: { sourcePath: string; reason: string }[]
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
    }

// Why: staging crosses IPC to the renderer and back into the streamer, so the
// shape lives in shared and every layer names the same type.
export type StagedExternalImportSource = StagedRuntimeUploadSource

export type StagedExternalImportEntry = StagedRuntimeUploadEntry
