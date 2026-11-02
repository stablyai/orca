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

// Staging crosses IPC into the renderer and back to the streamer; share one shape.
export type StagedExternalImportSource = StagedRuntimeUploadSource
export type StagedExternalImportEntry = StagedRuntimeUploadEntry
