import { translate } from '@/i18n/i18n'
import {
  isLockedWorktreeRemovalError,
  isProvenLivePtyRemovalError,
  isProvenLiveStructuredSessionRemovalError,
  type WorktreeForceDeleteReason
} from '../../../../shared/worktree/removal'
export type DeleteWorktreeToastCopy = {
  title: string
  description?: string
  isDestructive: boolean
}

export function getSubmoduleRemovalRefusalCopy(): string {
  return translate(
    'auto.components.sidebar.delete.worktree.toast.submodules',
    'This workspace contains submodules, so Git deletes it only with Force Delete. Force Delete also permanently removes anything in those submodules that was never pushed: commits, local branches and stashes.'
  )
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
        // Distinguish proven-live terminals from unverified exits because force delete can destroy their work.
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
    if (forceDeleteReason === 'running-agent-session') {
      return {
        title: translate(
          'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
          'Failed to delete workspace {{value0}}',
          { value0: worktreeName }
        ),
        // After attempted close, distinguish sessions observed attached from sessions we could not reach.
        description: isProvenLiveStructuredSessionRemovalError(error)
          ? translate(
              'auto.components.sidebar.delete.worktree.toast.runningAgentSessionLive',
              'This workspace still has running agent sessions that Orca could not close, so it stopped before deleting any files. Force Delete will discard any work they hold.'
            )
          : translate(
              'auto.components.sidebar.delete.worktree.toast.runningAgentSession',
              'Orca could not confirm every agent session in this workspace has closed, so it stopped before deleting any files. Use Force Delete to remove it anyway.'
            ),
        isDestructive: false
      }
    }
    if (forceDeleteReason === 'submodules') {
      return {
        title: translate(
          'auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5',
          'Failed to delete workspace {{value0}}',
          { value0: worktreeName }
        ),
        description: getSubmoduleRemovalRefusalCopy(),
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
      // Dirty worktrees need cleanup guidance and force delete rather than alarming raw Git stderr.
      isDestructive: false
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
