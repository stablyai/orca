export type CommitFailureDialogState = {
  worktreeKey: string
  open: boolean
}

export function getCommitFailureDialogWorktreeKey(worktreeId: string | null | undefined): string {
  return worktreeId ?? 'no-worktree'
}

export function shouldShowCommitFailureDialog(
  state: CommitFailureDialogState,
  worktreeKey: string,
  hasDetails: boolean
): boolean {
  return hasDetails && state.open && state.worktreeKey === worktreeKey
}

export function syncCommitFailureDialogState(
  state: CommitFailureDialogState,
  worktreeKey: string,
  hasDetails: boolean
): CommitFailureDialogState {
  if (state.worktreeKey === worktreeKey && hasDetails) {
    return state
  }

  if (state.worktreeKey === worktreeKey && !state.open) {
    return state
  }

  return { worktreeKey, open: false }
}
