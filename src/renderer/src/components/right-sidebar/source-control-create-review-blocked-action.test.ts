import { describe, expect, it } from 'vitest'
import {
  canClickBlockedCreateReviewReason,
  resolveBlockedCreateReviewNoticeMessage
} from './source-control-create-review-blocked-action'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'

function eligibility(
  overrides: Partial<HostedReviewCreationEligibility> = {}
): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: false,
    blockedReason: 'needs_push',
    nextAction: 'push',
    ...overrides
  }
}

describe('source-control-create-review-blocked-action', () => {
  it.each(['dirty', 'default_branch', 'no_upstream', 'needs_push', 'needs_sync', 'auth_required'])(
    'allows direct Create Review clicks for %s',
    (reason) => {
      expect(
        canClickBlockedCreateReviewReason(
          reason as NonNullable<HostedReviewCreationEligibility['blockedReason']>
        )
      ).toBe(true)
    }
  )

  it.each(['detached_head', 'existing_review', 'fork_head_unsupported', 'unsupported_provider'])(
    'keeps direct Create Review clicks disabled for %s',
    (reason) => {
      expect(
        canClickBlockedCreateReviewReason(
          reason as NonNullable<HostedReviewCreationEligibility['blockedReason']>
        )
      ).toBe(false)
    }
  )

  it('returns provider-localized auth guidance for blocked direct clicks', () => {
    expect(
      resolveBlockedCreateReviewNoticeMessage(
        eligibility({
          provider: 'gitlab',
          blockedReason: 'auth_required',
          nextAction: 'authenticate'
        })
      )
    ).toBe(
      'Create MR failed: GitLab is not authenticated. Next step: Run glab auth login in this environment.'
    )
  })

  it('returns a push-first notice for supported needs-push clicks', () => {
    expect(resolveBlockedCreateReviewNoticeMessage(eligibility())).toBe(
      'Create PR failed: push this branch before creating a pull request.'
    )
  })

  it('returns null when the blocked reason should remain non-clickable', () => {
    expect(
      resolveBlockedCreateReviewNoticeMessage(
        eligibility({
          blockedReason: 'existing_review',
          nextAction: 'open_existing_review'
        })
      )
    ).toBeNull()
  })
})
