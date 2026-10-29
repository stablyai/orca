import { describe, expect, it } from 'vitest'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import {
  filterWorkspaceCleanupCandidates,
  getWorkspaceCleanupGitLabel,
  getWorkspaceCleanupReviewInfo
} from './workspace-cleanup-presentation'
import {
  DEFAULT_FILTERS,
  NOW,
  makeCandidate,
  makeReview,
  makeState
} from './workspace-cleanup-presentation-fixtures'
import type { Repo } from '../../../../shared/repo-types'

describe('workspace cleanup presentation', () => {
  it('hides only the matching suppressed GitHub review', () => {
    const cacheKey = getHostedReviewCacheKey('/repo', 'alpha', {}, 'repo-1', undefined)
    const matching = makeState({
      worktreesByRepo: {
        'repo-1': [
          {
            ...makeState().worktreesByRepo['repo-1']![0]!,
            linkedPR: null,
            suppressedGitHubPR: 42
          }
        ]
      },
      hostedReviewCache: {
        [cacheKey]: { data: makeReview({ number: 42 }), fetchedAt: NOW }
      }
    })
    const different = makeState({
      ...matching,
      hostedReviewCache: {
        [cacheKey]: { data: makeReview({ number: 43 }), fetchedAt: NOW }
      }
    })

    expect(getWorkspaceCleanupReviewInfo(makeCandidate(), matching).hasReview).toBe(false)
    expect(getWorkspaceCleanupReviewInfo(makeCandidate(), different)).toMatchObject({
      hasReview: true,
      label: 'PR #43'
    })
  })

  it('host-qualifies same-id repo, worktree, and review cache joins', () => {
    const base = makeState()
    const localRepo = { ...base.repos[0]!, executionHostId: 'local' as const }
    const remoteRepo: Repo = {
      ...localRepo,
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    }
    const worktreeId = 'repo-1::/repo/alpha'
    const localWorktree = {
      ...base.worktreesByRepo['repo-1']![0]!,
      hostId: 'local' as const,
      linkedPR: 11
    }
    const remoteWorktree = {
      ...localWorktree,
      hostId: 'ssh:builder' as const,
      linkedPR: 22
    }
    const localKey = getHostedReviewCacheKey('/repo', 'alpha', {}, 'repo-1', null, 'local', true)
    const remoteKey = getHostedReviewCacheKey(
      '/repo',
      'alpha',
      {},
      'repo-1',
      'builder',
      'ssh:builder',
      true
    )
    const state = makeState({
      repos: [localRepo, remoteRepo],
      worktreesByRepo: { 'repo-1': [localWorktree, remoteWorktree] },
      hostedReviewCache: {
        [localKey]: { data: makeReview({ number: 11, title: 'Local review' }), fetchedAt: NOW },
        [remoteKey]: { data: makeReview({ number: 22, title: 'Remote review' }), fetchedAt: NOW }
      }
    })

    expect(
      getWorkspaceCleanupReviewInfo(
        makeCandidate({
          worktreeId,
          connectionId: 'builder',
          executionHostId: 'ssh:builder'
        }),
        state
      )
    ).toMatchObject({ label: 'PR #22', title: 'Remote review' })
  })

  it('does not guess a host for legacy same-id review joins', () => {
    const base = makeState()
    const duplicateRepo = {
      ...base.repos[0]!,
      connectionId: 'builder',
      executionHostId: 'ssh:builder' as const
    }
    const state = makeState({
      repos: [base.repos[0]!, duplicateRepo],
      worktreesByRepo: {
        'repo-1': [
          { ...base.worktreesByRepo['repo-1']![0]!, linkedPR: 11 },
          { ...base.worktreesByRepo['repo-1']![0]!, linkedPR: 22 }
        ]
      }
    })

    expect(getWorkspaceCleanupReviewInfo(makeCandidate(), state).hasReview).toBe(false)
  })

  it('treats unknown-base clean rows as unknown git risk', () => {
    const candidate = makeCandidate({
      git: { clean: true, upstreamAhead: null, upstreamBehind: null, checkedAt: NOW },
      blockers: ['unknown-base']
    })

    expect(getWorkspaceCleanupGitLabel(candidate)).toBe('Unknown')
    expect(
      filterWorkspaceCleanupCandidates(
        [candidate],
        { ...DEFAULT_FILTERS, git: 'clean' },
        new Map(),
        NOW
      )
    ).toEqual([])
    expect(
      filterWorkspaceCleanupCandidates(
        [candidate],
        { ...DEFAULT_FILTERS, git: 'unknown' },
        new Map(),
        NOW
      )
    ).toEqual([candidate])
  })
})
