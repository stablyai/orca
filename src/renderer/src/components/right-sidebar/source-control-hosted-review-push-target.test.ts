import { reviewTarget } from '../../../../shared/__fixtures__/git-review-target'
import { describe, expect, it } from 'vitest'
import {
  hasPositiveHostedReviewNumberLink,
  hasResolvableHostedReviewPushTargetLink,
  hasUsableHostedReviewPushTarget,
  resolveHostedReviewActionUpstreamStatus,
  resolveHostedReviewStateForActions
} from './source-control/review/hosted-review-push-target'

const unrelatedUpstream = {
  hasUpstream: true,
  upstreamName: 'origin/helper-branch',
  upstreamIdentity: {
    selector: { kind: 'named-remote' as const, value: 'origin' },
    mergeRef: 'refs/heads/helper-branch',
    trackingRef: 'refs/remotes/origin/helper-branch'
  },
  ahead: 1,
  behind: 0
}

describe('resolveHostedReviewActionUpstreamStatus', () => {
  it('blocks action status from using a local upstream while linked review state is loading', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: false,
        hostedReviewState: null,
        isHostedReviewStateLoading: true,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('blocks action status from using a local upstream for open reviews without a target', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: false,
        hostedReviewState: 'open',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('blocks explicit linked review metadata even when review state is unavailable', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: true,
        hostedReviewState: null,
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('does not block unknown-state review links when no target lookup exists', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: false,
        hostedReviewState: null,
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toBe(unrelatedUpstream)
  })

  it('keeps action status on the review target once one is usable', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: true,
        hostedReviewState: 'open',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: true,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'pr-user-repo/user/feature',
          upstreamIdentity: {
            selector: { kind: 'named-remote' as const, value: 'pr-user-repo' },
            mergeRef: 'refs/heads/user/feature',
            trackingRef: 'refs/remotes/pr-user-repo/user/feature'
          },
          ahead: 2,
          behind: 0
        }
      })
    ).toEqual({
      hasUpstream: true,
      upstreamName: 'pr-user-repo/user/feature',
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'pr-user-repo' },
        mergeRef: 'refs/heads/user/feature',
        trackingRef: 'refs/remotes/pr-user-repo/user/feature'
      },
      ahead: 2,
      behind: 0
    })
  })

  it('does not alter status for closed reviews', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: true,
        hostedReviewState: 'closed',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toBe(unrelatedUpstream)
  })

  it('does not alter status for merged reviews', () => {
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: true,
        hostedReviewState: 'merged',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget: false,
        upstreamStatus: unrelatedUpstream
      })
    ).toBe(unrelatedUpstream)
  })
})

describe('hasResolvableHostedReviewPushTargetLink', () => {
  it('accepts only hosted-review links with supported target lookup APIs', () => {
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: 12 })).toBe(true)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitLabMR: 34 })).toBe(true)
    // Why: a queue-discovered same-repo PR (no persisted linkedPR) is resolvable.
    expect(hasResolvableHostedReviewPushTargetLink({ fallbackGitHubPR: 8333 })).toBe(true)
    expect(
      hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: null, fallbackGitHubPR: 8333 })
    ).toBe(true)
    expect(hasResolvableHostedReviewPushTargetLink({ fallbackGitHubPR: 0 })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: null })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: 0 })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitLabMR: -1 })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitLabMR: 1.5 })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({ linkedGitHubPR: Number.NaN })).toBe(false)
    expect(hasResolvableHostedReviewPushTargetLink({})).toBe(false)
  })
})

describe('hasPositiveHostedReviewNumberLink', () => {
  it('accepts positive hosted-review metadata and rejects invalid values', () => {
    expect(hasPositiveHostedReviewNumberLink({ fallbackGitHubPR: 12 })).toBe(true)
    expect(hasPositiveHostedReviewNumberLink({ linkedBitbucketPR: 34 })).toBe(true)
    expect(hasPositiveHostedReviewNumberLink({ linkedAzureDevOpsPR: 56 })).toBe(true)
    expect(hasPositiveHostedReviewNumberLink({ linkedGiteaPR: 78 })).toBe(true)
    expect(
      hasPositiveHostedReviewNumberLink({
        linkedGitHubPR: 0,
        linkedGitLabMR: -1
      })
    ).toBe(false)
    expect(hasPositiveHostedReviewNumberLink({ linkedGitHubPR: Number.NaN })).toBe(false)
    expect(hasPositiveHostedReviewNumberLink({})).toBe(false)
  })

  it('blocks resolver-less providers without treating them as resolvable', () => {
    // Bitbucket/Azure/Gitea have no push-target resolver yet, so they must block
    // unsafe pushes but stay out of the resolvable subset. Locks the intended
    // relationship: resolvable ⊂ positive, so the two helpers cannot drift.
    for (const provider of ['linkedBitbucketPR', 'linkedAzureDevOpsPR', 'linkedGiteaPR'] as const) {
      const args = { [provider]: 42 }
      expect(hasPositiveHostedReviewNumberLink(args)).toBe(true)
      expect(hasResolvableHostedReviewPushTargetLink(args)).toBe(false)
    }
  })
})

describe('resolveHostedReviewStateForActions', () => {
  it('treats explicit linked review metadata as open when live state is unavailable', () => {
    expect(
      resolveHostedReviewStateForActions({
        hostedReviewState: null,
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe('open')
  })

  it('preserves known hosted review states', () => {
    expect(
      resolveHostedReviewStateForActions({
        hostedReviewState: 'merged',
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe('merged')
    expect(
      resolveHostedReviewStateForActions({
        hostedReviewState: 'closed',
        hasResolvableHostedReviewPushTargetLink: false
      })
    ).toBe('closed')
  })

  it('leaves unknown review state empty when no target lookup exists', () => {
    expect(
      resolveHostedReviewStateForActions({
        hostedReviewState: null,
        hasResolvableHostedReviewPushTargetLink: false
      })
    ).toBeNull()
  })
})

describe('hasUsableHostedReviewPushTarget', () => {
  it('keeps old-peer labels unresolved before and after target hydration', () => {
    const upstreamStatus = {
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 1,
      behind: 0
    }
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        branchName: 'feature',
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        pushTarget: { remoteName: 'origin', branchName: 'feature' }
      })
    ).toBe(false)
  })

  it('distinguishes equal labels with different named remote and merge identities', () => {
    const upstreamStatus = {
      reviewPushAuthority: {
        kind: 'verified' as const,
        reviewHead: reviewTarget('origin/team', 'feature').reviewHead
      },
      hasUpstream: true,
      upstreamName: 'origin/team/feature',
      ahead: 1,
      behind: 0,
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'origin/team' },
        mergeRef: 'refs/heads/feature',
        trackingRef: 'refs/custom/published'
      }
    }
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        pushTarget: reviewTarget('origin/team', 'feature')
      })
    ).toBe(true)
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        pushTarget: { remoteName: 'origin', branchName: 'team/feature' }
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus: {
          ...upstreamStatus,
          upstreamIdentity: {
            ...upstreamStatus.upstreamIdentity,
            selector: { kind: 'literal-url' }
          }
        },
        pushTarget: reviewTarget('origin/team', 'feature')
      })
    ).toBe(false)
  })

  it('keeps branch identity unresolved before hydration regardless of tag-shaped labels', () => {
    const upstreamStatus = {
      hasUpstream: true,
      upstreamName: 'remotes/origin/heads/feature',
      ahead: 1,
      behind: 0,
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'origin' },
        mergeRef: 'refs/heads/heads/feature',
        trackingRef: 'refs/custom/head'
      }
    }
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        branchName: 'heads/feature',
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus,
        branchName: 'feature',
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
  })

  it('rejects legacy target metadata and retains ordinary configured push policy', () => {
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget: { remoteName: 'fork', branchName: 'feature' },
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'fork/feature',
          upstreamIdentity: {
            selector: { kind: 'named-remote' as const, value: 'fork' },
            mergeRef: 'refs/heads/feature',
            trackingRef: 'refs/remotes/fork/feature'
          },
          ahead: 1,
          behind: 0
        }
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        upstreamStatus: {
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          hasConfiguredPushTarget: true
        }
      })
    ).toBe(true)
    expect(
      hasUsableHostedReviewPushTarget({
        hasResolvableHostedReviewPushTargetLink: true,
        upstreamStatus: {
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          hasConfiguredPushTarget: true
        }
      })
    ).toBe(false)
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget: { remoteName: 'fork', branchName: 'feature' },
        upstreamStatus: unrelatedUpstream
      })
    ).toBe(false)
    expect(hasUsableHostedReviewPushTarget({ upstreamStatus: unrelatedUpstream })).toBe(false)
  })

  it('requires review repository evidence even when an upstream branch matches', () => {
    expect(
      hasUsableHostedReviewPushTarget({
        hasResolvableHostedReviewPushTargetLink: true,
        branchName: 'feature/foo',
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature/foo',
          upstreamIdentity: {
            selector: { kind: 'named-remote' as const, value: 'origin' },
            mergeRef: 'refs/heads/feature/foo',
            trackingRef: 'refs/remotes/origin/feature/foo'
          },
          ahead: 7,
          behind: 2
        }
      })
    ).toBe(false)
  })

  it('keeps blocking a review whose upstream tracks an unrelated fork/helper head', () => {
    expect(
      hasUsableHostedReviewPushTarget({
        hasResolvableHostedReviewPushTargetLink: true,
        branchName: 'feature',
        upstreamStatus: unrelatedUpstream
      })
    ).toBe(false)
  })

  it('keeps blocking a resolvable review with no real upstream', () => {
    expect(
      hasUsableHostedReviewPushTarget({
        hasResolvableHostedReviewPushTargetLink: true,
        branchName: 'feature',
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
      })
    ).toBe(false)
  })
})

describe('resolveHostedReviewActionUpstreamStatus with a same-repo upstream', () => {
  it('keeps an unhydrated review unresolved despite matching upstream', () => {
    const realUpstream = {
      hasUpstream: true,
      upstreamName: 'origin/mobile-resume-suspected-fixes',
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'origin' },
        mergeRef: 'refs/heads/mobile-resume-suspected-fixes',
        trackingRef: 'refs/remotes/origin/mobile-resume-suspected-fixes'
      },
      ahead: 7,
      behind: 2
    }
    const canUseHostedReviewPushTarget = hasUsableHostedReviewPushTarget({
      hasResolvableHostedReviewPushTargetLink: true,
      branchName: 'mobile-resume-suspected-fixes',
      upstreamStatus: realUpstream
    })
    expect(canUseHostedReviewPushTarget).toBe(false)
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: true,
        hostedReviewState: 'open',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget,
        upstreamStatus: realUpstream
      })
    ).toMatchObject({ hasUpstream: false, ahead: 0, behind: 0 })
  })

  it('blocks queue-discovered review push until its target is resolved', () => {
    // Why: a child worktree with no persisted linkedPR discovers its open PR via
    // the queue (fallbackGitHubPR). Before the fix, that PR counted as a hosted
    // review link but not a resolvable target, so the real matching upstream was
    // ignored and Push was wrongly disabled as "target unavailable".
    const realUpstream = {
      hasUpstream: true,
      upstreamName: 'origin/fix-f1-codex-wsl-path-trust',
      upstreamIdentity: {
        selector: { kind: 'named-remote' as const, value: 'origin' },
        mergeRef: 'refs/heads/fix-f1-codex-wsl-path-trust',
        trackingRef: 'refs/remotes/origin/fix-f1-codex-wsl-path-trust'
      },
      ahead: 1,
      behind: 0
    }
    const hasResolvable = hasResolvableHostedReviewPushTargetLink({
      linkedGitHubPR: null,
      fallbackGitHubPR: 8333,
      linkedGitLabMR: null
    })
    expect(hasResolvable).toBe(true)
    const canUseHostedReviewPushTarget = hasUsableHostedReviewPushTarget({
      hasResolvableHostedReviewPushTargetLink: hasResolvable,
      branchName: 'fix-f1-codex-wsl-path-trust',
      upstreamStatus: realUpstream
    })
    expect(canUseHostedReviewPushTarget).toBe(false)
    expect(
      resolveHostedReviewActionUpstreamStatus({
        hasHostedReviewLink: true,
        hasResolvableHostedReviewPushTargetLink: hasResolvable,
        hostedReviewState: 'open',
        isHostedReviewStateLoading: false,
        canUseHostedReviewPushTarget,
        upstreamStatus: realUpstream
      })
    ).toMatchObject({ hasUpstream: false, ahead: 0, behind: 0 })
  })
})
