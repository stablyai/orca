import type { SshMutationExpectation } from '../remote-runtime/ssh/ssh-types'

export type RuntimeUploadSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

/** Fence source swaps between staging and upload; size alone misses same-size replacements. */
export type StagedRuntimeUploadFileIdentity = {
  byteLength: number
  /** 0 when the filesystem does not report one; compared only when both sides have it. */
  inode: number
  deviceId: number
  modifiedAtMs: number
}

export type StagedRuntimeUploadEntry =
  | { relativePath: string; kind: 'directory' }
  // Recheck staged identity against the file handle actually streamed at upload time.
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

/** Bytes this source contributes to the drop budget; 0 unless it staged. */
export function stagedRuntimeUploadByteLength(source: StagedRuntimeUploadSource): number {
  if (source.status !== 'staged') {
    return 0
  }
  return source.entries.reduce(
    (total, entry) => (entry.kind === 'file' ? total + entry.byteLength : total),
    0
  )
}

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
  /** Set to receive progress events and allow cancel; unique per file upload. */
  uploadId?: string
} & SshMutationExpectation

/** Main → renderer: bytes of one file the runtime has acknowledged. */
export type RuntimeUploadProgressEvent = { uploadId: string; sentBytes: number }
