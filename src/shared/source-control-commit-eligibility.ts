export const COMMIT_MESSAGE_REQUIRED_REASON = 'Enter a commit message to commit' as const

export type CommitDisabledReason =
  | 'Resolve conflicts before committing'
  | 'Stage at least one file to commit'
  | typeof COMMIT_MESSAGE_REQUIRED_REASON

export type CommitEligibilityInputs = {
  stagedCount: number
  hasPartiallyStagedChanges: boolean
  hasMessage: boolean
  hasUnresolvedConflicts: boolean
  isCommitting: boolean
  isRemoteOperationActive: boolean
  isPullRequestOperationActive?: boolean
}

export function resolveCommitDisabledReason(
  inputs: Pick<
    CommitEligibilityInputs,
    'stagedCount' | 'hasPartiallyStagedChanges' | 'hasMessage' | 'hasUnresolvedConflicts'
  >
): CommitDisabledReason | null {
  if (inputs.hasUnresolvedConflicts) {
    return 'Resolve conflicts before committing'
  }
  if (inputs.stagedCount === 0) {
    return 'Stage at least one file to commit'
  }
  if (!inputs.hasMessage) {
    return COMMIT_MESSAGE_REQUIRED_REASON
  }
  return null
}

function isCommitGloballyBusy(inputs: CommitEligibilityInputs): boolean {
  return (
    inputs.isCommitting ||
    inputs.isRemoteOperationActive ||
    (inputs.isPullRequestOperationActive ?? false)
  )
}

export function canSubmitCommit(inputs: CommitEligibilityInputs): boolean {
  return !isCommitGloballyBusy(inputs) && resolveCommitDisabledReason(inputs) === null
}

// The field is a text editor — busy ops and unresolved conflicts lock typing; staging and message
// rules gate the Commit button, not editing (amend reword types with nothing staged).
export function isCommitMessageFieldDisabled(inputs: CommitEligibilityInputs): boolean {
  return isCommitGloballyBusy(inputs) || inputs.hasUnresolvedConflicts
}
