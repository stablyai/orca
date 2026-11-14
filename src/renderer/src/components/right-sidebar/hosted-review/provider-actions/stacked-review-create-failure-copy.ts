import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  STACKED_REVIEW_FAILURE_COPY as EN,
  type StackedReviewFailureReason
} from '../../../../../../shared/source-control/hosted-review/stacked-hosted-review-failure-copy'

// undefined = the branch name the sentence needs is missing; callers fall back to `error`.
export function stackedFailureMessage(
  reason: StackedReviewFailureReason,
  base: string | undefined,
  head: string | undefined,
  t: Translate = translate
): string | undefined {
  switch (reason) {
    case 'stack_github_only':
      return t('sourceControl.createReviewFailure.stacked.stackGithubOnly', EN.stack_github_only)
    case 'stack_github_com_only':
      return t(
        'sourceControl.createReviewFailure.stacked.stackGithubComOnly',
        EN.stack_github_com_only
      )
    case 'stack_same_parent':
      return t('sourceControl.createReviewFailure.stacked.stackSameParent', EN.stack_same_parent)
    case 'stack_parent_without_review':
      return base
        ? t(
            'sourceControl.createReviewFailure.stacked.stackParentWithoutReview',
            EN.stack_parent_without_review,
            { base }
          )
        : undefined
    case 'stack_parent_ambiguous':
      return base
        ? t(
            'sourceControl.createReviewFailure.stacked.stackParentAmbiguous',
            EN.stack_parent_ambiguous,
            { base }
          )
        : undefined
    case 'stack_head_ambiguous':
      return head
        ? t(
            'sourceControl.createReviewFailure.stacked.stackHeadAmbiguous',
            EN.stack_head_ambiguous,
            { head }
          )
        : undefined
    case 'stack_parent_multiple_stacks':
      return t(
        'sourceControl.createReviewFailure.stacked.stackParentMultipleStacks',
        EN.stack_parent_multiple_stacks
      )
    case 'stack_parent_closed':
      return t(
        'sourceControl.createReviewFailure.stacked.stackParentClosed',
        EN.stack_parent_closed
      )
    case 'stack_parent_not_top':
      return t(
        'sourceControl.createReviewFailure.stacked.stackParentNotTop',
        EN.stack_parent_not_top
      )
    case 'stack_conflict':
      return t('sourceControl.createReviewFailure.stacked.stackConflict', EN.stack_conflict)
    case 'stacks_unavailable':
      return t('sourceControl.createReviewFailure.stacked.stacksUnavailable', EN.stacks_unavailable)
    case 'stack_parent_unverified':
      return t(
        'sourceControl.createReviewFailure.stacked.stackParentUnverified',
        EN.stack_parent_unverified
      )
    case 'stack_existing_review_other_base':
      return t(
        'sourceControl.createReviewFailure.stacked.stackExistingReviewOtherBase',
        EN.stack_existing_review_other_base
      )
    case 'stack_creation_unconfirmed':
      return t(
        'sourceControl.createReviewFailure.stacked.stackCreationUnconfirmed',
        EN.stack_creation_unconfirmed
      )
    case 'stack_registration_unavailable':
      return t(
        'sourceControl.createReviewFailure.stacked.stackRegistrationUnavailable',
        EN.stack_registration_unavailable
      )
    case 'stack_registration_failed':
      return t(
        'sourceControl.createReviewFailure.stacked.stackRegistrationFailed',
        EN.stack_registration_failed
      )
  }
}
