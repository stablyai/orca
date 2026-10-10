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
