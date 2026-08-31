import { translate } from '@/i18n/i18n'
import {
  isHeldWorkspaceDirectoryRemovalError,
  isLockedWorktreeRemovalError,
  isProvenLivePtyRemovalError,
  isUnprovenOrphanedWorktreeDirectoryError,
  type WorktreeForceDeleteReason
} from '../../../../shared/worktree/removal'
export type DeleteWorktreeToastCopy = {
  title: string
  description?: string
  isDestructive: boolean
}

export function getDeleteWorktreeToastCopy(
  worktreeName: string,
  forceDeleteReason: WorktreeForceDeleteReason | null,
  error: string,
  lockReason: string | null = null
): DeleteWorktreeToastCopy {
  if (isLockedWorktreeRemovalError(error)) {
    return {
      title: translate(
        'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
        'Failed to delete workspace {{value0}}',
        { value0: worktreeName }
      ),
      description: lockReason
        ? translate(
            'auto.components.sidebar.delete.worktree.toast.lockedReason',
            'This workspace is locked by Git. Git reported: {{value0}}. Run git worktree unlock <worktree-path> from its repository, then retry deletion.',
            { value0: lockReason }
          )
        : translate(
            'auto.components.sidebar.delete.worktree.toast.locked',
            'This workspace is locked by Git. Run git worktree unlock <worktree-path> from its repository, then retry deletion.'
          ),
      isDestructive: false
    }
  }

  // Why (STA-4895): this failure matches no force-delete reason, so it would otherwise fall to
  // the raw-error branch and render the main process's English hint verbatim. That hint stays
  // put as the wire anchor the classifier matches on; the copy the user reads comes from here.
  if (isHeldWorkspaceDirectoryRemovalError(error)) {
    return {
      title: translate(
        'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
        'Failed to delete workspace {{value0}}',
        { value0: worktreeName }
      ),
      description: translate(
        'auto.components.sidebar.delete.worktree.toast.workspaceDirectoryHeld',
        'Windows would not delete the workspace folder because a program may still have it open or access was denied. Close any terminal, editor, or dev server whose current folder is the workspace, then delete it again; if nothing is using it, check the folder permissions.'
      ),
      isDestructive: true
    }
  }

  if (forceDeleteReason) {
    if (forceDeleteReason === 'orphan-directory') {
      return {
        title: translate(
          'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
          'Failed to delete workspace {{value0}}',
          { value0: worktreeName }
        ),
        description: translate(
          'auto.components.sidebar.delete.worktree.toast.0899ebdb28',
          'Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory.'
        ),
        isDestructive: false
      }
    }
    if (forceDeleteReason === 'unstopped-pty') {
      return {
        title: translate(
          'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
          'Failed to delete workspace {{value0}}',
          { value0: worktreeName }
        ),
        // Why: Force Delete proceeds either way, so the copy must say which case this is.
        // Telling a user "could not confirm" about terminals Orca watched stay alive asks
        // them to waive a doubt that does not exist, and any running agent's work dies with it.
        description: isProvenLivePtyRemovalError(error)
          ? translate(
              'auto.components.sidebar.delete.worktree.toast.unstoppedPtyLive',
              'This workspace still has running terminals, so Orca stopped before deleting any files. Force Delete will kill them and discard any uncommitted work they hold.'
            )
          : translate(
              'auto.components.sidebar.delete.worktree.toast.unstoppedPty',
              'Orca could not confirm every terminal in this workspace has exited, so it stopped before deleting any files. Use Force Delete to remove it anyway.'
            ),
        isDestructive: false
      }
    }
    if (forceDeleteReason === 'missing-registration') {
      return {
        title: translate(
          'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
          'Failed to delete workspace {{value0}}',
          { value0: worktreeName }
        ),
        description: translate(
          'auto.components.sidebar.delete.worktree.toast.905fc8efac',
          'Git already removed this workspace. Use Force Delete to clear it from Orca.'
        ),
        isDestructive: false
      }
    }
    return {
      title: translate(
        'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
        'Failed to delete workspace {{value0}}',
        { value0: worktreeName }
      ),
      description: translate(
        'auto.components.sidebar.delete.worktree.toast.ead7b8ee15',
        'It has changed files. Use Force Delete to delete it anyway.'
      ),
      // Why: git commonly refuses the first delete when the worktree still has
      // modified or untracked files. Showing raw stderr in a destructive toast
      // made a normal cleanup step look like an Orca bug, so this common case
      // gets a concise explanation plus the force-delete path instead.
      isDestructive: false
    }
  }

  // Why (STA-4895): Orca refusing an unproven orphan cleanup matches no force-delete reason, so
  // without this it reaches the raw branch below and the main process's English sentence is what
  // the user reads. Placed after the force-delete arms so it can never shadow an affordance's copy.
  if (isUnprovenOrphanedWorktreeDirectoryError(error)) {
    return {
      title: translate(
        'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
        'Failed to delete workspace {{value0}}',
        { value0: worktreeName }
      ),
      description: translate(
        'auto.components.sidebar.delete.worktree.toast.unprovenOrphanDirectory',
        'Git no longer tracks this workspace, but Orca could not confirm its folder was safe to delete, so it left the files on disk. Check the folder yourself and remove it once you are sure it is no longer needed.'
      ),
      isDestructive: true
    }
  }

  return {
    title: translate(
      'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
      'Failed to delete workspace {{value0}}',
      { value0: worktreeName }
    ),
    description: error,
    isDestructive: true
  }
}
