import { describe, expect, it } from 'vitest'
import {
  resolveCommitAreaPrimaryAction,
  resolvePrimaryAction,
  type PrimaryActionInputs
} from './source-control-primary-action'
import { resolveCreatePrHeaderAction } from './source-control-primary-create-pr-intent-action'

function inputs(overrides: Partial<PrimaryActionInputs> = {}): PrimaryActionInputs {
  return {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: false,
    upstreamStatus: undefined,
    ...overrides
  }
}

const upstreamInSync = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 0,
  behind: 0
}

describe('resolvePrimaryAction Create PR intent', () => {
  it('returns Create PR intent for an unpublished clean branch with commits to publish', () => {
    const result = resolvePrimaryAction(
      inputs({
        upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
        branchCommitsAhead: 2,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'no_upstream',
          nextAction: 'publish'
        }
      })
    )
    expect(result.kind).toBe('create_pr_intent')
    expect(result.disabled).toBe(false)
  })

  it('returns Create PR intent for patch-equivalent force-push before review', () => {
    const result = resolvePrimaryAction(
      inputs({
        branchCommitsAhead: 4,
        upstreamStatus: {
          hasUpstream: true,
          upstreamName: 'origin/feature',
          ahead: 14,
          behind: 3,
          behindCommitsArePatchEquivalent: true
        },
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'needs_sync',
          nextAction: 'sync'
        }
      })
    )
    expect(result.kind).toBe('create_pr_intent')
    expect(result.disabled).toBe(false)
  })

  it('returns Create PR intent for a behind-only branch (fast-forward sync)', () => {
    const input = inputs({
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 0,
        behind: 3
      },
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'needs_sync',
        nextAction: 'sync'
      }
    })
    const result = resolvePrimaryAction(input)
    expect(result.kind).toBe('create_pr_intent')
    expect(result.disabled).toBe(false)
    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
  })

  it('returns Create PR intent for a branch that needs a safe push before review', () => {
    const input = inputs({
      upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'needs_push',
        nextAction: 'push'
      }
    })
    const result = resolvePrimaryAction(input)
    expect(result.kind).toBe('create_pr_intent')
    expect(result.disabled).toBe(false)
    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
    expect(resolveCommitAreaPrimaryAction(input)).toEqual({
      kind: 'push',
      label: 'Push',
      title: 'Push 2 commits',
      disabled: false
    })
  })

  it('returns Create PR intent for a dirty tree when hosted review prep can commit changes', () => {
    const result = resolvePrimaryAction(
      inputs({
        hasUnstagedChanges: true,
        hasStageableChanges: true,
        upstreamStatus: upstreamInSync,
        hostedReviewCreation: {
          provider: 'github',
          review: null,
          canCreate: false,
          blockedReason: 'dirty',
          nextAction: 'commit'
        }
      })
    )
    expect(result).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          stagedCount: 0,
          hasUnstagedChanges: true,
          hasStageableChanges: true,
          upstreamStatus: upstreamInSync,
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: false,
            blockedReason: 'dirty',
            nextAction: 'commit'
          }
        })
      )
    ).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
  })

  it('returns Create PR intent for staged changes without a message so the flow can request one', () => {
    const input = inputs({
      stagedCount: 1,
      hasMessage: false,
      upstreamStatus: upstreamInSync,
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'dirty',
        nextAction: 'commit'
      }
    })
    const result = resolvePrimaryAction(input)
    expect(result.kind).toBe('create_pr_intent')
    expect(result.disabled).toBe(false)
    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
  })

  it('keeps default branch blockers on the direct notice path', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          stagedCount: 1,
          upstreamStatus: upstreamInSync,
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: false,
            blockedReason: 'default_branch',
            nextAction: null
          }
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Cannot create a pull request from the default branch.',
      disabled: false
    })
  })

  it('returns Create MR intent with provider copy for a GitLab dirty branch', () => {
    const result = resolvePrimaryAction(
      inputs({
        stagedCount: 1,
        hasMessage: true,
        upstreamStatus: upstreamInSync,
        hostedReviewCreation: {
          provider: 'gitlab',
          review: null,
          canCreate: false,
          blockedReason: 'dirty',
          nextAction: 'commit'
        }
      })
    )
    expect(result.kind).toBe('create_pr_intent')
    expect(result.label).toBe('Create MR')
    expect(result.title).toBe('Prepare this branch and create a merge request')
  })

  it('routes a GitLab dirty branch header through Create MR intent', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          stagedCount: 1,
          hasMessage: true,
          upstreamStatus: upstreamInSync,
          hostedReviewCreation: {
            provider: 'gitlab',
            review: null,
            canCreate: false,
            blockedReason: 'dirty',
            nextAction: 'commit'
          }
        })
      )
    ).toEqual({
      kind: 'create_pr_intent',
      label: 'Create MR',
      title: 'Prepare this branch and create a merge request',
      disabled: false
    })
  })

  it('keeps in-flight Create MR intent copy provider-aware', () => {
    const input = inputs({
      isPrIntentInFlight: true,
      hostedReviewCreation: {
        provider: 'gitlab',
        review: null,
        canCreate: false,
        blockedReason: 'dirty',
        nextAction: 'commit'
      }
    })

    expect(resolvePrimaryAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create MR',
      title: 'Preparing branch for review…',
      disabled: true
    })
    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create MR',
      title: 'Preparing branch for review…',
      disabled: true
    })
  })

  it.each(['azure-devops', 'gitea'] as const)(
    'returns Create PR intent for a %s branch that needs a safe push before review',
    (provider) => {
      const result = resolvePrimaryAction(
        inputs({
          upstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
          hostedReviewCreation: {
            provider,
            review: null,
            canCreate: false,
            blockedReason: 'needs_push',
            nextAction: 'push'
          }
        })
      )
      expect(result).toEqual({
        kind: 'create_pr_intent',
        label: 'Create PR',
        title: 'Prepare this branch and create a pull request',
        disabled: false
      })
    }
  )

  it('routes unpublished commits through Create PR intent while keeping Publish Branch in the commit area', () => {
    const input = inputs({
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
      branchCommitsAhead: 2,
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'no_upstream',
        nextAction: 'publish'
      }
    })

    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
    expect(resolveCommitAreaPrimaryAction(input)).toEqual({
      kind: 'publish',
      label: 'Publish Branch',
      title: 'Publish this branch to origin',
      disabled: false
    })
  })

  it('routes patch-equivalent divergence through Create PR intent while keeping Force Push in the commit area', () => {
    const input = inputs({
      branchCommitsAhead: 4,
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 14,
        behind: 3,
        behindCommitsArePatchEquivalent: true
      },
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'needs_sync',
        nextAction: 'sync'
      }
    })

    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr_intent',
      label: 'Create PR',
      title: 'Prepare this branch and create a pull request',
      disabled: false
    })
    expect(resolveCommitAreaPrimaryAction(input)).toEqual({
      kind: 'push',
      label: 'Force Push',
      title:
        'Remote only has older copies of local commits. Force push 4 branch commits with lease to update origin/feature.',
      disabled: false
    })
  })

  it('keeps unsafe sync blockers on the direct notice path', () => {
    const input = inputs({
      branchCommitsAhead: 4,
      upstreamStatus: {
        hasUpstream: true,
        upstreamName: 'origin/feature',
        ahead: 2,
        behind: 3
      },
      hostedReviewCreation: {
        provider: 'github',
        review: null,
        canCreate: false,
        blockedReason: 'needs_sync',
        nextAction: 'sync'
      }
    })

    expect(resolveCreatePrHeaderAction(input)).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Sync this branch before creating a pull request.',
      disabled: false
    })
  })

  it('returns direct Create PR as a header action when the branch is ready', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          upstreamStatus: upstreamInSync,
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: true,
            blockedReason: null,
            nextAction: null
          }
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Create a pull request for this branch',
      disabled: false
    })
  })

  it('returns a disabled loading Create PR header while eligibility is still fetching', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: false,
            blockedReason: null,
            nextAction: null
          },
          isHostedReviewCreationLoading: true
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Checking whether this branch can create a pull request…',
      disabled: true
    })
  })

  it('keeps stale Create PR eligibility disabled while a newer preflight is loading', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: true,
            blockedReason: null,
            nextAction: null
          },
          isHostedReviewCreationLoading: true
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Checking whether this branch can create a pull request…',
      disabled: true
    })
  })

  it('keeps stale Create MR eligibility disabled with provider-aware loading copy', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          hostedReviewCreation: {
            provider: 'gitlab',
            review: null,
            canCreate: true,
            blockedReason: null,
            nextAction: null
          },
          isHostedReviewCreationLoading: true
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create MR',
      title: 'Checking whether this branch can create a merge request…',
      disabled: true
    })
  })

  it('returns a clickable Create PR header notice path when the branch has nothing to publish yet', () => {
    expect(
      resolveCreatePrHeaderAction(
        inputs({
          upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 },
          branchCommitsAhead: 0,
          hostedReviewCreation: {
            provider: 'github',
            review: null,
            canCreate: false,
            blockedReason: 'no_upstream',
            nextAction: 'publish'
          }
        })
      )
    ).toEqual({
      kind: 'create_pr',
      label: 'Create PR',
      title: 'Publish commits before creating a pull request.',
      disabled: false
    })
  })
})
