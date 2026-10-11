import type { DownloadProgressTracker } from '@/components/transfer-progress/download-progress-tracker'
import type { RuntimeClientTarget } from './runtime-client-target'
import type { LocalFileAccess } from '../../../shared/local-file-access'

export type RuntimeReadableFileContent = {
  mediaUrl?: string
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  fileIdentity?: string
}

export type RuntimeFileReadArgs = {
  /** The file owner's transport; never the focused server. */
  target: RuntimeClientTarget
  filePath: string
  relativePath?: string
  worktreeId?: string
  connectionId?: string
  expectedExternalSshTargetId?: string
  includeLocalLogMetadata?: boolean
  /** File access of the local fallback read; remote reads stay root-relative. */
  access?: LocalFileAccess
  /** Host grant for a runtime file outside every workspace (see OpenFile.terminalArtifactGrantId). */
  terminalArtifactGrantId?: string
}

export type RuntimeFileOperationArgs = {
  /** The worktree owner's transport; never the focused server. */
  target: RuntimeClientTarget
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId?: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExternalSshTargetId?: string
}

export type RuntimeFileDownloadResult =
  | { canceled: true }
  | { canceled: false; destinationPath: string }

/** Lets a runtime download report progress and be canceled. */
export type RuntimeFileDownloadTransfer = {
  signal: AbortSignal
  trackProgress: (totalBytes: number | null) => DownloadProgressTracker
}
