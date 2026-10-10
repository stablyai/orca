import type { GlobalSettings } from '../../../shared/global-settings-types'
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
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
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
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId?: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  /** True when a runtime execution host's files live in this machine's filesystem:
   * a local host, or a runtime environment whose endpoint is loopback. Absent
   * means unknown — callers must not assume the files are here. */
  runtimeHostIsLocalMachine?: boolean
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExternalSshTargetId?: string
}

export type RuntimeFileDownloadResult =
  | { canceled: true }
  | { canceled: false; destinationPath: string }
