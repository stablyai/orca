import type {
  SourceControlPrimaryActionDecision,
  SourceControlPrimaryActionDecisionInputs
} from './source-control-primary-action-decision-types'

export function resolveUnpublishedSourceControlPrimaryAction({
  hasCurrentBranch,
  isPRStateLoading,
  prState
}: Pick<
  SourceControlPrimaryActionDecisionInputs,
  'hasCurrentBranch' | 'isPRStateLoading' | 'prState'
>): SourceControlPrimaryActionDecision {
  if (!hasCurrentBranch) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'checkout_branch_before_publish',
      disabled: true
    }
  }

  if (isPRStateLoading) {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'checking_review_status',
      disabled: true
    }
  }

  if (prState === 'merged') {
    return {
      kind: 'commit',
      labelIntent: 'commit',
      titleIntent: 'review_already_merged',
      disabled: true
    }
  }

  return {
    kind: 'publish',
    labelIntent: 'publish',
    titleIntent: 'publish_branch',
    disabled: false
  }
}
