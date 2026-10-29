import type { CreateHostedReviewErrorCode } from './hosted-review'

// One English table for stacked PR failures: main builds the wire `error`, the renderer translates by `reason`.
export const STACKED_REVIEW_FAILURE_COPY = {
  stack_github_only: 'Stacked pull request creation is available only for GitHub repositories.',
  stack_github_com_only: 'GitHub stacked pull requests are available only on GitHub.com.',
  stack_same_parent: 'Choose a different parent branch before creating a stacked pull request.',
  stack_parent_without_review:
    'The parent branch {{base}} does not have an open pull request. Create that pull request first.',
  stack_parent_ambiguous: 'Orca found multiple open pull requests for the parent branch {{base}}.',
  stack_head_ambiguous: 'Orca found multiple open pull requests for the current branch {{head}}.',
  stack_parent_multiple_stacks: 'The selected parent pull request belongs to multiple stacks.',
  stack_parent_closed: 'The selected parent belongs to a closed stack.',
  stack_parent_not_top:
    'Choose the top pull request in the stack as the base branch before adding another layer.',
  stack_conflict: 'The pull request already belongs to a different GitHub stack.',
  stacks_unavailable: 'GitHub stacked pull requests are not available for this repository.',
  stack_parent_unverified: 'Orca could not verify the parent pull request. Retry in a moment.',
  stack_existing_review_other_base:
    'An open pull request already exists for this branch but does not target the selected parent branch.',
  stack_creation_unconfirmed:
    'Pull request creation may have completed. Retry to finish stack registration.',
  stack_registration_unavailable:
    'The pull request was created, but GitHub stacks are not available for this repository.',
  stack_registration_failed:
    'The pull request was created, but GitHub could not add it to the stack. Retry to finish stack registration.'
} as const

export type StackedReviewFailureReason = keyof typeof STACKED_REVIEW_FAILURE_COPY

export function isStackedReviewFailureReason(
  reason: unknown
): reason is StackedReviewFailureReason {
  return typeof reason === 'string' && Object.hasOwn(STACKED_REVIEW_FAILURE_COPY, reason)
}

/** English wire text; `base`/`head` fill their slots in one pass so branch names stay verbatim. */
export function stackedReviewFailureText(
  reason: StackedReviewFailureReason,
  refs: { base?: string; head?: string } = {}
): string {
  return STACKED_REVIEW_FAILURE_COPY[reason].replace(
    /\{\{(base|head)\}\}/g,
    (_slot, slot: 'base' | 'head') => refs[slot] ?? ''
  )
}

/** A failed stacked create result whose English `error` matches older hosts. */
export function stackedReviewFailure(
  reason: StackedReviewFailureReason,
  refs: { base?: string; head?: string } = {},
  code: CreateHostedReviewErrorCode = 'validation'
): {
  ok: false
  code: CreateHostedReviewErrorCode
  error: string
  reason: StackedReviewFailureReason
  base?: string
  head?: string
} {
  return { ok: false, code, error: stackedReviewFailureText(reason, refs), reason, ...refs }
}
