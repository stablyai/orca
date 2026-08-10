import { translate } from '@/i18n/i18n'
import { stageAtLeastOneFileToCommitTitle } from './source-control-primary-action-titles'

/** Stable English sentinel for equality checks; localize at display via localizeCommitDisabledReason(). */
export const COMMIT_MESSAGE_REQUIRED_REASON = 'Enter a commit message to commit' as const

export function localizeCommitDisabledReason(reason: string | null): string | null {
  if (reason === null) {
    return null
  }
  if (reason === COMMIT_MESSAGE_REQUIRED_REASON) {
    return translate(
      'auto.components.rightSidebar.sourceControl.enterCommitMessage',
      'Enter a commit message to commit'
    )
  }
  return reason
}

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
): string | null {
  if (inputs.hasUnresolvedConflicts) {
    return translate(
      'auto.components.rightSidebar.sourceControl.resolveConflictsBeforeCommitting',
      'Resolve conflicts before committing'
    )
  }
  if (inputs.stagedCount === 0) {
    return stageAtLeastOneFileToCommitTitle()
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

// Why: the message field stays editable when the only blocker is an empty
// message; every other commit-disabled reason or in-flight op locks typing.
export function isCommitMessageFieldDisabled(inputs: CommitEligibilityInputs): boolean {
  if (isCommitGloballyBusy(inputs)) {
    return true
  }
  const commitDisabledReason = resolveCommitDisabledReason(inputs)
  return commitDisabledReason !== null && commitDisabledReason !== COMMIT_MESSAGE_REQUIRED_REASON
}
