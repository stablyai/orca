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
    return {
      title: `Failed to delete worktree ${worktreeName}`,
      description: 'It has changed files. Use Force Delete to delete it anyway.',
      // Why: git commonly refuses the first delete when the worktree still has
      // modified or untracked files. Showing raw stderr in a destructive toast
      // made a normal cleanup step look like an Orca bug, so this common case
      // gets a concise explanation plus the force-delete path instead.
      isDestructive: false
    }
  }

  return {
    title: `Failed to delete worktree ${worktreeName}`,
    description: error,
    isDestructive: true
  }
}
