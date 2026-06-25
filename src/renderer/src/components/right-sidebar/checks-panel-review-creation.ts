import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { normalizeHostedReviewBaseRef } from '../../../../shared/hosted-review-refs'

export function resolveChecksPanelHostedReviewBaseRef(input: {
  worktreeBaseRef?: string | null
  repoBaseRef?: string | null
}): string | null {
  const worktreeBaseRef = normalizeChecksPanelHostedReviewBaseRef(input.worktreeBaseRef)
  return worktreeBaseRef || normalizeChecksPanelHostedReviewBaseRef(input.repoBaseRef)
}

function normalizeChecksPanelHostedReviewBaseRef(ref: string | null | undefined): string | null {
  const normalizedRef = ref ? normalizeHostedReviewBaseRef(ref) : ''
  return normalizedRef || null
}

export function shouldOpenChecksPanelCreateComposer(input: {
  activeReview: unknown | null
  isFolder: boolean
  branch: string
  hostedReviewCreation: HostedReviewCreationEligibility | null
}): boolean {
  return (
    !input.activeReview &&
    !input.isFolder &&
    Boolean(input.branch) &&
    (input.hostedReviewCreation?.canCreate === true ||
      input.hostedReviewCreation?.blockedReason === 'needs_push')
  )
}
