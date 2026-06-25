import { describe, expect, it } from 'vitest'
import {
  resolveChecksPanelHostedReviewBaseRef,
  shouldOpenChecksPanelCreateComposer
} from './checks-panel-review-creation'

describe('resolveChecksPanelHostedReviewBaseRef', () => {
  it('prefers the worktree base ref over the repo default', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: ' release/1.4 ',
        repoBaseRef: 'main'
      })
    ).toBe('release/1.4')
  })

  it('falls back to the repo base ref when the worktree has no override', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: null,
        repoBaseRef: ' main '
      })
    ).toBe('main')
  })

  it('returns null when both inputs are null', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: null,
        repoBaseRef: null
      })
    ).toBe(null)
  })

  it('returns null when worktree base ref is whitespace-only', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: '   ',
        repoBaseRef: null
      })
    ).toBe(null)
  })

  it('strips origin prefix from the worktree base ref', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: 'origin/main',
        repoBaseRef: 'develop'
      })
    ).toBe('main')
  })

  it('strips upstream prefix from the repo base ref', () => {
    expect(
      resolveChecksPanelHostedReviewBaseRef({
        worktreeBaseRef: null,
        repoBaseRef: 'upstream/develop'
      })
    ).toBe('develop')
  })
})

describe('shouldOpenChecksPanelCreateComposer', () => {
  it('opens for GitLab MR creation eligibility', () => {
    expect(
      shouldOpenChecksPanelCreateComposer({
        activeReview: null,
        isFolder: false,
        branch: 'feature/gitlab-mr',
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    ).toBe(true)
  })

  it('opens for push-before-create recovery', () => {
    expect(
      shouldOpenChecksPanelCreateComposer({
        activeReview: null,
        isFolder: false,
        branch: 'feature/gitlab-mr',
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: 'needs_push',
          nextAction: 'push'
        }
      })
    ).toBe(true)
  })

  it('does not open when an active review exists', () => {
    expect(
      shouldOpenChecksPanelCreateComposer({
        activeReview: { provider: 'github', number: 123 },
        isFolder: false,
        branch: 'feature/test',
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    ).toBe(false)
  })

  it('does not open for folder repos', () => {
    expect(
      shouldOpenChecksPanelCreateComposer({
        activeReview: null,
        isFolder: true,
        branch: 'feature/test',
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    ).toBe(false)
  })

  it('does not open when branch is empty', () => {
    expect(
      shouldOpenChecksPanelCreateComposer({
        activeReview: null,
        isFolder: false,
        branch: '',
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: true,
          blockedReason: null,
          nextAction: null
        }
      })
    ).toBe(false)
  })
})
