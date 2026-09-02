import { describe, expect, it } from 'vitest'
import {
  getChecksPanelReviewState,
  shouldShowChecksPanelPublishBranchAction,
  type ChecksPanelReviewStateInput
} from './checks-panel-empty-state'

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

describe('getChecksPanelReviewState — no-review honesty', () => {
  it('only renders "No pull request found" for an accepted no-review result', () => {
    expect(getChecksPanelReviewState(input({ reviewLookup: 'not_found' })).title).toBe(
      'No pull request found'
    )
  })

  it('never says "No pull request found" for a missing/unknown lookup', () => {
    const state = getChecksPanelReviewState(input({ reviewLookup: 'unknown' }))
    expect(state.title).not.toContain('No pull request found')
    expect(state.title).toBe('Pull request status unavailable')
  })

  it('never says "No pull request found" for a paused refresh', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'unknown', refresh: { status: 'paused' } })
    )
    expect(state.title).toBe('GitHub refresh paused')
  })

  it('never says "No pull request found" for a skipped refresh', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'unknown', refresh: { status: 'skipped', skippedReason: 'bare' } })
    )
    expect(state.title).toBe('Bare repository')
  })

  it('uses merge request wording for GitLab', () => {
    const state = getChecksPanelReviewState(
      input({
        reviewLabel: 'merge request',
        reviewShortLabel: 'MR',
        providerName: 'GitLab',
        isGitHubProvider: false,
        reviewLookup: 'not_found'
      })
    )
    expect(state.title).toBe('No merge request found')
  })
})

describe('getChecksPanelReviewState — precedence', () => {
  it('operation in progress wins', () => {
    expect(
      getChecksPanelReviewState(input({ operationLabel: 'Rebase', reviewLookup: 'not_found' }))
        .title
    ).toBe('Rebase in progress')
  })

  it('renderReview for found lookup', () => {
    expect(getChecksPanelReviewState(input({ reviewLookup: 'found' })).renderReview).toBe(true)
  })

  it('positive_unresolved blocks create and offers Open Review', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'positive_unresolved', openReviewUrl: 'https://x/pull/1' })
    )
    expect(state.title).toBe('Pull request details unavailable')
    expect(state.composerMode).toBe('hidden')
    expect(state.workflowAction).toBeNull()
    expect(state.recovery).toContain('open_review')
    expect(state.openReviewUrl).toBe('https://x/pull/1')
  })

  it('offers Open Review under a branch blocker when positive evidence has a trusted URL', () => {
    // A concurrent branch blocker owns the copy but must not swallow the known
    // review: Open Review is exposed while Create / Push & Create stay suppressed.
    const state = getChecksPanelReviewState(
      input({
        reviewLookup: 'positive_unresolved',
        openReviewUrl: 'https://x/pull/7',
        eligibilityBlockedReason: 'no_upstream',
        hasUpstream: false
      })
    )
    expect(state.title).toBe('No upstream configured')
    expect(state.workflowAction).toBe('publish_branch')
    expect(state.composerMode).toBe('hidden')
    expect(state.recovery).toContain('open_review')
    expect(state.openReviewUrl).toBe('https://x/pull/7')
  })

  it('needs_sync emits a sync_branch workflow action for the renderer', () => {
    const state = getChecksPanelReviewState(input({ eligibilityBlockedReason: 'needs_sync' }))
    expect(state.title).toBe('Branch needs to sync')
    expect(state.workflowAction).toBe('sync_branch')
  })

  it('branch blocker (no_upstream) ranks above a refresh error', () => {
    const state = getChecksPanelReviewState(
      input({
        eligibilityBlockedReason: 'no_upstream',
        hasUpstream: false,
        refresh: { status: 'error', errorType: 'auth' }
      })
    )
    expect(state.title).toBe('No upstream configured')
    expect(state.workflowAction).toBe('publish_branch')
    // Hard error concurrent with the blocker: detail appended, create suppressed.
    expect(state.detail).toBe(
      'Orca also could not confirm whether this branch already has a pull request.'
    )
  })

  it('existing_review with a fetch in flight shows Checking status, not the terminal card', () => {
    // Regression (#9428): the terminal "already exists" card short-circuited the
    // in-flight fetch window, so the panel stalled until a manual refresh.
    const state = getChecksPanelReviewState(
      input({ eligibilityBlockedReason: 'existing_review', refresh: { status: 'in-flight' } })
    )
    expect(state.title).toBe('Checking pull request status')
    expect(state.renderReview).toBe(false)
    expect(state.recovery).toEqual([])
  })

  it('positive_unresolved with a queued fetch shows Checking status', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'positive_unresolved', refresh: { status: 'queued' } })
    )
    expect(state.title).toBe('Checking pull request status')
  })

  it('existing_review with no active fetch keeps the terminal already-exists card', () => {
    const state = getChecksPanelReviewState(
      input({ eligibilityBlockedReason: 'existing_review', openReviewUrl: 'https://x/pull/1' })
    )
    expect(state.title).toBe('Pull request already exists')
    expect(state.recovery).toContain('open_review')
  })

  it('a concurrent branch blocker still owns the copy over an in-flight fetch', () => {
    const state = getChecksPanelReviewState(
      input({
        eligibilityBlockedReason: 'no_upstream',
        reviewLookup: 'positive_unresolved',
        hasUpstream: false,
        refresh: { status: 'in-flight' }
      })
    )
    expect(state.title).toBe('No upstream configured')
  })

  it('a safety blocker still owns the copy over positive evidence and an in-flight fetch', () => {
    const state = getChecksPanelReviewState(
      input({
        eligibilityBlockedReason: 'dirty',
        reviewLookup: 'positive_unresolved',
        refresh: { status: 'in-flight' }
      })
    )
    expect(state.title).toBe('Commit changes first')
  })

  it('hard refresh error hides the composer', () => {
    const state = getChecksPanelReviewState(
      input({ refresh: { status: 'error', errorType: 'auth' } })
    )
    expect(state.title).toBe('GitHub authentication failed')
    expect(state.composerMode).toBe('hidden')
    expect(state.workflowAction).toBeNull()
  })

  it('hard refresh error overrides an accepted no-review', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'not_found', refresh: { status: 'error', errorType: 'permission' } })
    )
    expect(state.title).toBe('GitHub access denied')
  })
})

describe('getChecksPanelReviewState — composer preserve', () => {
  it('accepted no-review with confirmed readiness opens the composer', () => {
    const state = getChecksPanelReviewState(
      input({ reviewLookup: 'not_found', confirmedReadiness: true })
    )
    expect(state.composerMode).toBe('confirmed_open')
    expect(state.workflowAction).toBe('create')
  })

  it('transient error preserves a confirmed composer', () => {
    const state = getChecksPanelReviewState(
      input({ confirmedReadiness: true, refresh: { status: 'error', errorType: 'network' } })
    )
    expect(state.composerMode).toBe('confirmed_open')
    expect(state.title).toBe('Could not reach GitHub')
  })

  it('attributes a transient 5xx outage to GitHub and preserves a confirmed composer', () => {
    const state = getChecksPanelReviewState(
      input({ confirmedReadiness: true, refresh: { status: 'error', errorType: 'server_error' } })
    )
    expect(state).toMatchObject({
      title: 'GitHub is unavailable',
      description:
        "GitHub's API is temporarily unavailable. This panel reloads automatically once it recovers.",
      composerMode: 'confirmed_open',
      workflowAction: 'create'
    })
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

describe('getChecksPanelReviewState — schedule', () => {
  it('carries auto-retry schedule on the paused row', () => {
    const state = getChecksPanelReviewState(
      input({ refresh: { status: 'paused', nextAutoRetryAt: 123, retryDisabledUntil: 123 } })
    )
    expect(state.autoRetryAt).toBe(123)
    expect(state.retryDisabledUntil).toBe(123)
  })

  it('carries auto-retry schedule on a transient network error', () => {
    const state = getChecksPanelReviewState(
      input({ refresh: { status: 'error', errorType: 'network', nextAutoRetryAt: 456 } })
    )
    expect(state.autoRetryAt).toBe(456)
    expect(state.retryDisabledUntil).toBeUndefined()
  })
})

describe('getChecksPanelReviewState — git status', () => {
  it('shows loading copy when upstream is unknown', () => {
    expect(
      getChecksPanelReviewState(input({ gitStatusPhase: 'loading', hasUpstream: undefined })).title
    ).toBe('Checking branch status')
  })

  it('shows failed copy when the probe failed and upstream is unknown', () => {
    const state = getChecksPanelReviewState(
      input({ gitStatusPhase: 'error', hasUpstream: undefined })
    )
    expect(state.title).toBe('Could not check branch status')
    expect(state.recovery).toContain('retry')
    expect(state.composerMode).toBe('hidden')
  })
})

describe('getChecksPanelReviewState — active and skipped', () => {
  it('queued shows checking copy', () => {
    expect(getChecksPanelReviewState(input({ refresh: { status: 'queued' } })).title).toBe(
      'Checking pull request status'
    )
  })

  it('disconnected host row', () => {
    expect(
      getChecksPanelReviewState(
        input({ refresh: { status: 'skipped', skippedReason: 'disconnected' } })
      ).title
    ).toBe('Host disconnected')
  })
})

describe('shouldShowChecksPanelPublishBranchAction', () => {
  it('shows publish when eligibility reports no upstream', () => {
    expect(
      shouldShowChecksPanelPublishBranchAction({
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: undefined
      })
    ).toBe(true)
  })

  it('does not show publish when HEAD is detached', () => {
    expect(
      shouldShowChecksPanelPublishBranchAction({
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false,
        hasCurrentBranch: false
      })
    ).toBe(false)
  })
})
