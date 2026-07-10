import { describe, expect, it } from 'vitest'
import {
  getChecksPanelEmptyStateCopy,
  shouldShowChecksPanelPublishBranchAction
} from './checks-panel-empty-state'

describe('getChecksPanelEmptyStateCopy', () => {
  it('shows a local-only branch message instead of a refresh error', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false
      })
    ).toEqual({
      title: 'Branch not published',
      description: 'Publish this branch before creating a pull request.'
    })
  })

  it('uses remote status as a fallback before eligibility finishes', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: undefined,
        hasUpstream: false
      }).title
    ).toBe('Branch not published')
  })

  it('does not show unpublished branch copy when HEAD is detached', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false,
        hasCurrentBranch: false
      }).title
    ).toBe('Could not refresh pull request')
  })

  it('uses remote status as a fallback when eligibility has no concrete blocker', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: null,
        hasUpstream: false
      }).title
    ).toBe('Branch not published')
  })

  it('shows unpushed commits before a refresh error', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: 'needs_push',
        hasUpstream: true
      })
    ).toEqual({
      title: 'Branch has unpushed commits',
      description: 'Push your branch before creating a pull request.'
    })
  })

  it('shows unpublished branch copy even when PR provider eligibility has another blocker', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: 'unsupported_provider',
        hasUpstream: false
      }).title
    ).toBe('Branch not published')
  })

  it('keeps the generic refresh error when no local branch action is known', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: null,
        hasUpstream: true
      }).title
    ).toBe('Could not refresh pull request')
  })

  it('uses merge request copy for GitLab review contexts', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: undefined,
        hostedReviewBlockedReason: 'unsupported_provider',
        hasUpstream: true,
        reviewLabel: 'merge request',
        reviewShortLabel: 'MR'
      })
    ).toEqual({
      title: 'No merge request found',
      description: 'Create a merge request to start checks and review.'
    })
  })

  it('uses neutral copy when GitHub hosted-review data exists without PR cache', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: undefined,
        hostedReviewBlockedReason: null,
        hasUpstream: true,
        hasAmbiguousGitHubHostedReview: true
      })
    ).toEqual({
      title: 'Pull request status unavailable',
      description: 'Refresh GitHub status for this branch to load checks and review.'
    })
  })

  it('does not show no-PR copy for paused ambiguous GitHub hosted-review data', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'paused',
        hostedReviewBlockedReason: null,
        hasUpstream: true,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  it('keeps refresh errors for ambiguous GitHub hosted-review data', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: null,
        hasUpstream: true,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Could not refresh pull request')
  })

  it('uses neutral copy for ambiguous GitHub hosted-review data before unpublished branch copy', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: undefined,
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  it('uses neutral copy for ambiguous GitHub hosted-review data before remote fallback publish copy', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: undefined,
        hostedReviewBlockedReason: undefined,
        hasUpstream: false,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  it('uses neutral copy for ambiguous GitHub hosted-review data before unpushed commit copy', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: undefined,
        hostedReviewBlockedReason: 'needs_push',
        hasUpstream: true,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  // Regression: a local-only branch with an ambiguous GitHub hosted-review card
  // flip-flopped between "Branch not published" (during an active PR refresh) and
  // "Pull request status unavailable" (while idle) as background refreshes cycled
  // the status. The ambiguous copy must stay stable across the whole lifecycle.
  it('keeps stable ambiguous copy while a PR refresh is queued on an unpublished branch', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'queued',
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  it('keeps stable ambiguous copy while a PR refresh is in-flight on an unpublished branch', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'in-flight',
        hostedReviewBlockedReason: undefined,
        hasUpstream: false,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Pull request status unavailable')
  })

  it('does not fall back to unpublished-branch copy on refresh error for ambiguous data', () => {
    expect(
      getChecksPanelEmptyStateCopy({
        operationLabel: null,
        prRefreshStatus: 'error',
        hostedReviewBlockedReason: 'no_upstream',
        hasUpstream: false,
        hasAmbiguousGitHubHostedReview: true
      }).title
    ).toBe('Could not refresh pull request')
  })

  it('renders a single stable title across a full ambiguous refresh cycle', () => {
    const cycle = ['queued', 'in-flight', undefined, 'skipped', 'paused'] as const
    const titles = new Set(
      cycle.map(
        (prRefreshStatus) =>
          getChecksPanelEmptyStateCopy({
            operationLabel: null,
            prRefreshStatus,
            hostedReviewBlockedReason: 'no_upstream',
            hasUpstream: false,
            hasAmbiguousGitHubHostedReview: true
          }).title
      )
    )
    expect([...titles]).toEqual(['Pull request status unavailable'])
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

  it('uses remote status even when provider eligibility has a separate blocker', () => {
    expect(
      shouldShowChecksPanelPublishBranchAction({
        hostedReviewBlockedReason: undefined,
        hasUpstream: false
      })
    ).toBe(true)
    expect(
      shouldShowChecksPanelPublishBranchAction({
        hostedReviewBlockedReason: 'unsupported_provider',
        hasUpstream: false
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
