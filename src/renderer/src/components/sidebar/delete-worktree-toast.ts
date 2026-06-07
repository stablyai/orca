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
        title: `Failed to delete workspace ${worktreeName}`,
        description:
          'Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory.',
        isDestructive: false
      }
    }
    if (
      error.includes('Worktree is no longer registered with Git and its directory is already gone.')
    ) {
      return {
        title: `Failed to delete workspace ${worktreeName}`,
        description: 'Git already removed this workspace. Use Force Delete to clear it from Orca.',
        isDestructive: false
      }
    }
    return {
      title: `Failed to delete workspace ${worktreeName}`,
      description: 'It has changed files. Use Force Delete to delete it anyway.',
      // Why: git commonly refuses the first delete when the worktree still has
      // modified or untracked files. Showing raw stderr in a destructive toast
      // made a normal cleanup step look like an Orca bug, so this common case
      // gets a concise explanation plus the force-delete path instead.
      isDestructive: false
    }
  }

  return {
    title: `Failed to delete workspace ${worktreeName}`,
    description: error,
    isDestructive: true
  }
}
