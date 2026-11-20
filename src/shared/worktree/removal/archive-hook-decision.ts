import { z } from 'zod'

/** Workspace whose archive hook the desktop is asked about; `folderWorkspaceId` selects a group folder workspace. */
export const ArchiveHookApprovalParams = z.union([
  z.object({ worktreeId: z.string().min(1), hostId: z.string().min(1) }),
  z.object({ folderWorkspaceId: z.string().min(1), hostId: z.string().min(1) })
])
export type ArchiveHookApprovalRequest = z.infer<typeof ArchiveHookApprovalParams>

/**
 * What the desktop's Delete would do without prompting. `approvedArchiveHash` pins what was decided
 * (the approved version, or the empty hash when nothing needed approval); repo-wide trust pins none.
 */
export type ArchiveHookApproval =
  | { decision: 'run'; approvedArchiveHash?: string }
  | { decision: 'needs-approval' }
  | { decision: 'undecided' }

export type ArchiveHookChoice = 'run' | 'skip' | 'inherit'

export type ArchiveHookReport = {
  decision: 'run' | 'skip'
  reason: 'requested' | 'approved' | 'not-approved' | 'older-host'
  /** Host evidence that the hook process started; null when the host didn't say. */
  ran: boolean | null
}

/** Refused before anything is deleted: the default needs the desktop's answer and could not get one. */
export const ARCHIVE_HOOK_UNDECIDED_CODE = 'worktree_archive_hook_undecided'

/** Refused before anything is deleted: the archive script changed after it was approved. */
export const ARCHIVE_HOOK_CHANGED_CODE = 'worktree_archive_hook_changed'

/** False when the hook process never started; null when it started but no exit was observed. */
export function archiveHookRanFrom(result: {
  success: boolean
  exitCode?: number
  started?: false
}): boolean | null {
  if (result.started === false) {
    return false
  }
  return result.success || typeof result.exitCode === 'number' ? true : null
}
