import type { GitDiffResult } from '../../../../shared/types'

/**
 * Thrown when a worktree's host owner is not yet known (the backing repo has
 * not hydrated). The retry gate treats this as transient so the read recovers
 * once the SSH connection finishes establishing, instead of latching a local
 * "access denied" for a remote path (#6648).
 */
export const WORKTREE_OWNER_NOT_READY_ERROR =
  'Connecting to the remote host… retrying once the workspace is ready.'

/**
 * Terminal message shown once the owner-not-ready retry budget is exhausted —
 * the remote host never finished connecting. Truthful (no longer claims it is
 * still retrying) and points the user at the Retry button, which starts a fresh
 * budget (#6648).
 */
export const WORKTREE_OWNER_UNREACHABLE_ERROR =
  "Couldn't reach the remote host. Check the connection, then retry."

export type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  fileIdentity?: string
  loadError?: string
}

export type DiffContent = GitDiffResult
