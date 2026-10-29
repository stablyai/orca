import { translate } from '@/i18n/i18n'
import {
  STACKED_REVIEW_FAILURE_COPY as EN,
  type StackedReviewFailureReason
} from '../../../../shared/stacked-hosted-review-failure-copy'

// undefined = the branch name the sentence needs is missing; callers fall back to `error`.
export function stackedFailureMessage(
  reason: StackedReviewFailureReason,
  base: string | undefined,
  head: string | undefined
): string | undefined {
  switch (reason) {
    case 'stack_github_only':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackGithubOnly',
        EN.stack_github_only
      )
    case 'stack_github_com_only':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackGithubComOnly',
        EN.stack_github_com_only
      )
    case 'stack_same_parent':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackSameParent',
        EN.stack_same_parent
      )
    case 'stack_parent_without_review':
      return base
        ? translate(
            'sourceControl.createReviewFailure.stacked.stackParentWithoutReview',
            EN.stack_parent_without_review,
            { base }
          )
        : undefined
    case 'stack_parent_ambiguous':
      return base
        ? translate(
            'sourceControl.createReviewFailure.stacked.stackParentAmbiguous',
            EN.stack_parent_ambiguous,
            { base }
          )
        : undefined
    case 'stack_head_ambiguous':
      return head
        ? translate(
            'sourceControl.createReviewFailure.stacked.stackHeadAmbiguous',
            EN.stack_head_ambiguous,
            { head }
          )
        : undefined
    case 'stack_parent_multiple_stacks':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackParentMultipleStacks',
        EN.stack_parent_multiple_stacks
      )
    case 'stack_parent_closed':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackParentClosed',
        EN.stack_parent_closed
      )
    case 'stack_parent_not_top':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackParentNotTop',
        EN.stack_parent_not_top
      )
    case 'stack_conflict':
      return translate('sourceControl.createReviewFailure.stacked.stackConflict', EN.stack_conflict)
    case 'stacks_unavailable':
      return translate(
        'sourceControl.createReviewFailure.stacked.stacksUnavailable',
        EN.stacks_unavailable
      )
    case 'stack_parent_unverified':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackParentUnverified',
        EN.stack_parent_unverified
      )
    case 'stack_existing_review_other_base':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackExistingReviewOtherBase',
        EN.stack_existing_review_other_base
      )
    case 'stack_creation_unconfirmed':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackCreationUnconfirmed',
        EN.stack_creation_unconfirmed
      )
    case 'stack_registration_unavailable':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackRegistrationUnavailable',
        EN.stack_registration_unavailable
      )
    case 'stack_registration_failed':
      return translate(
        'sourceControl.createReviewFailure.stacked.stackRegistrationFailed',
        EN.stack_registration_failed
      )
  }
}
