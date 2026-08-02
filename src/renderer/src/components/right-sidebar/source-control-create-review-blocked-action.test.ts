import { describe, expect, it } from 'vitest'
import {
  canClickBlockedCreateReviewReason,
  resolveBlockedCreateReviewNoticeMessage,
  resolveUnavailableCreateReviewLookupNoticeMessage
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
    reviewLookupOutcome: 'not_found',
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

  it('preserves a known dirty-tree prerequisite when review lookup is unavailable', () => {
    expect(
      resolveBlockedCreateReviewNoticeMessage(
        eligibility({
          blockedReason: 'dirty',
          nextAction: 'commit',
          reviewLookupOutcome: 'unavailable'
        })
      )
    ).toBe('Create PR failed: commit or discard local changes before creating a pull request.')
  })

  it('preserves authentication guidance when review lookup is unavailable', () => {
    expect(
      resolveBlockedCreateReviewNoticeMessage(
        eligibility({
          provider: 'gitlab',
          blockedReason: 'auth_required',
          nextAction: 'authenticate',
          reviewLookupOutcome: 'unavailable'
        })
      )
    ).toBe(
      'Create MR failed: GitLab is not authenticated. Next step: Run glab auth login in this environment.'
    )
  })

  it('reports unavailable review lookup authority when no local blocker is known', () => {
    expect(resolveUnavailableCreateReviewLookupNoticeMessage('gitlab')).toBe(
      'Create MR failed: Orca could not confirm whether this branch already has a merge request. Retry once the GitLab lookup succeeds.'
    )
    expect(
      resolveBlockedCreateReviewNoticeMessage(
        eligibility({
          provider: 'gitlab',
          blockedReason: null,
          nextAction: null,
          reviewLookupOutcome: 'unavailable'
        })
      )
    ).toBe(
      'Create MR failed: Orca could not confirm whether this branch already has a merge request. Retry once the GitLab lookup succeeds.'
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
