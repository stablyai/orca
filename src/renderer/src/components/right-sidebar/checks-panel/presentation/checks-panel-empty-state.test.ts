import { describe, expect, it } from 'vitest'
import { getChecksPanelReviewState } from './checks-panel-empty-state'
import type { ChecksPanelReviewStateInput } from '../checks-panel-review-state-model'

function input(overrides: Partial<ChecksPanelReviewStateInput> = {}): ChecksPanelReviewStateInput {
  return {
    operationLabel: null,
    reviewLabel: 'pull request',
    reviewShortLabel: 'PR',
    providerName: 'GitHub',
    isGitHubProvider: true,
    reviewLookup: 'unknown',
    openReviewUrl: null,
    eligibilityBlockedReason: undefined,
    confirmedReadiness: false,
    confirmedNeedsPush: false,
    refresh: undefined,
    gitStatusPhase: 'ready',
    hasUpstream: true,
    hasCurrentBranch: true,
    ...overrides
  }
}

describe('getChecksPanelReviewState — precedence', () => {
  it('positive evidence and an existing review share the Open + Retry layout and never create', () => {
    for (const overrides of [
      { reviewLookup: 'positive_unresolved' as const },
      { reviewLookup: 'not_found' as const, eligibilityBlockedReason: 'existing_review' as const },
      {
        reviewLookup: 'positive_unresolved' as const,
        confirmedReadiness: true,
        refresh: { status: 'in-flight' as const }
      }
    ]) {
      const state = getChecksPanelReviewState(
        input({ ...overrides, openReviewUrl: 'https://x/pull/1' })
      )
      expect(state.positiveReview).toBe(true)
      expect(state.composerMode).toBe('hidden')
      expect(state.workflowAction).toBeNull()
      expect(state.recovery).toEqual(['open_review', 'retry'])
      expect(state.openReviewUrl).toBe('https://x/pull/1')
    }
  })

  it('offers Open Review under a branch blocker when positive evidence has a trusted URL', () => {
    // Branch guidance must preserve known Open Review while suppressing create actions.
    const state = getChecksPanelReviewState(
      input({
        reviewLookup: 'positive_unresolved',
        reviewNumber: 7,
        openReviewUrl: 'https://x/pull/7',
        eligibilityBlockedReason: 'no_upstream',
        hasUpstream: false
      })
    )
    expect(state.title).toBe('No upstream configured')
    expect(state.description).toBe('Push to update PR #7.')
    expect(state.workflowAction).toBe('publish_branch')
    expect(state.composerMode).toBe('hidden')
    expect(state.recovery).toContain('open_review')
    expect(state.openReviewUrl).toBe('https://x/pull/7')
  })

  it('hard refresh error hides the composer', () => {
    const state = getChecksPanelReviewState(
      input({ refresh: { status: 'error', errorType: 'auth' } })
    )
    expect(state.title).toBe('GitHub authentication failed')
    expect(state.composerMode).toBe('hidden')
    expect(state.workflowAction).toBeNull()
  })
})

describe('getChecksPanelReviewState — composer preserve', () => {
  it('transient error preserves a confirmed composer', () => {
    const state = getChecksPanelReviewState(
      input({ confirmedReadiness: true, refresh: { status: 'error', errorType: 'network' } })
    )
    expect(state.composerMode).toBe('confirmed_open')
    expect(state.title).toBe('Could not reach GitHub')
  })

  it('transient error without confirmed readiness never opens a composer', () => {
    const state = getChecksPanelReviewState(
      input({ confirmedReadiness: false, refresh: { status: 'error', errorType: 'network' } })
    )
    expect(state.composerMode).toBe('hidden')
  })

  it('needs_push with positive_unresolved never exposes Push & Create', () => {
    const state = getChecksPanelReviewState(
      input({
        eligibilityBlockedReason: 'needs_push',
        reviewLookup: 'positive_unresolved',
        confirmedReadiness: true,
        confirmedNeedsPush: true
      })
    )
    expect(state.composerMode).toBe('hidden')
    expect(state.workflowAction).toBeNull()
  })

  it('needs_push with confirmed readiness offers Push & Create', () => {
    const state = getChecksPanelReviewState(
      input({
        eligibilityBlockedReason: 'needs_push',
        reviewLookup: 'not_found',
        confirmedReadiness: true,
        confirmedNeedsPush: true
      })
    )
    expect(state.composerMode).toBe('needs_push_open')
    expect(state.workflowAction).toBe('push_and_create')
  })
})
