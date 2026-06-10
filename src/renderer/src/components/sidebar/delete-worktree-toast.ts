import { translate } from '@/i18n/i18n'
export type DeleteWorktreeToastCopy = {
  title: string
  description?: string
  isDestructive: boolean
}

export function getDeleteWorktreeToastCopy(
  worktreeName: string,
  canForceDelete: boolean,
  error: string
): DeleteWorktreeToastCopy {
  if (canForceDelete) {
    if (error.includes('Worktree is no longer registered with Git but its directory remains.')) {
      return {
        title: translate("auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5", "Failed to delete workspace {{value0}}", { value0: worktreeName }),
        description:
          translate("auto.components.sidebar.delete.worktree.toast.0899ebdb28", "Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory."),
        isDestructive: false
      }
    }
    if (
      error.includes('Worktree is no longer registered with Git and its directory is already gone.')
    ) {
      return {
        title: translate("auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5", "Failed to delete workspace {{value0}}", { value0: worktreeName }),
        description: translate("auto.components.sidebar.delete.worktree.toast.905fc8efac", "Git already removed this workspace. Use Force Delete to clear it from Orca."),
        isDestructive: false
      }
    }
    return {
      title: translate("auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5", "Failed to delete workspace {{value0}}", { value0: worktreeName }),
      description: translate("auto.components.sidebar.delete.worktree.toast.ead7b8ee15", "It has changed files. Use Force Delete to delete it anyway."),
      // Why: git commonly refuses the first delete when the worktree still has
      // modified or untracked files. Showing raw stderr in a destructive toast
      // made a normal cleanup step look like an Orca bug, so this common case
      // gets a concise explanation plus the force-delete path instead.
      isDestructive: false
    }
  }

  return {
    title: translate("auto.components.sidebar.delete.worktree.toast.1d0fa5c0a5", "Failed to delete workspace {{value0}}", { value0: worktreeName }),
    description: error,
    isDestructive: true
  }
}
