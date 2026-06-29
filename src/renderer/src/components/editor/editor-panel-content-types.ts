import type { GitDiffResult } from '../../../../shared/types'

/**
 * Thrown when a worktree's host owner is not yet known (the backing repo has
 * not hydrated). The retry gate treats this as transient so the read recovers
 * once the SSH connection finishes establishing, instead of latching a local
 * "access denied" for a remote path (#6648).
 */
export const WORKTREE_OWNER_NOT_READY_ERROR =
  'Connecting to the remote host… retrying once the workspace is ready.'

export type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  loadError?: string
}

export type DiffContent = GitDiffResult
