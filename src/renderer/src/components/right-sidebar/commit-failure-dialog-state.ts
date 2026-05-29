export type CommitFailureDialogState = {
  identity: string
  open: boolean
}

export function resolveCommitFailureDialogState(
  state: CommitFailureDialogState,
  currentIdentity: string
): CommitFailureDialogState {
  return state.identity === currentIdentity ? state : { identity: currentIdentity, open: false }
}
