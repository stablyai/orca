import type { SshMutationExpectation } from './ssh-types'

export type RuntimeUploadSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

/**
 * What staging observed about a file, so the uploader can refuse a source that
 * was swapped between the two calls. Size alone misses a same-size replacement.
 */
export type StagedRuntimeUploadFileIdentity = {
  byteLength: number
  /** 0 when the filesystem does not report one; compared only when both sides have it. */
  inode: number
  deviceId: number
  modifiedAtMs: number
}

export type StagedRuntimeUploadEntry =
  | { relativePath: string; kind: 'directory' }
  // Why: file bodies are streamed in slices at upload time, so staging carries
  // identity the uploader re-checks against the handle it actually reads.
  | ({ relativePath: string; kind: 'file' } & StagedRuntimeUploadFileIdentity)

export type StagedRuntimeUploadSource =
  | {
      sourcePath: string
      status: 'staged'
      name: string
      kind: 'file' | 'directory'
      entries: StagedRuntimeUploadEntry[]
    }
  | { sourcePath: string; status: 'skipped'; reason: RuntimeUploadSkipReason }
  | { sourcePath: string; status: 'failed'; reason: string }

export type StageRuntimeUploadResult = { sources: StagedRuntimeUploadSource[] }

/** Renderer → main request to pump one staged file's bytes to the runtime. */
export type RuntimeUploadFileStreamRequest = {
  environmentId: string
  /** Client-local path of the dropped source (file, or root of a dropped directory). */
  sourceRootPath: string
  /** Path of this file within the dropped directory; empty when the source is a file. */
  entryRelativePath: string
  /** Identity staging recorded; a source that no longer matches is refused, not streamed. */
  expected: StagedRuntimeUploadFileIdentity
  worktree: string
  /** Destination path on the runtime, relative to the worktree. */
  relativePath: string
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
} & SshMutationExpectation
