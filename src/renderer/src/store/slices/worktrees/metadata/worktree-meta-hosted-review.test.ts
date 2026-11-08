import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import 'sonner'
import type { RuntimeEnvironmentCallRequest } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'

import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('clears stale hosted review cache and force-refetches when removing linked PR metadata', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/pr-branch',
      linkedPR: 456
    })
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => ({
      id: `test-${method}`,
      ok: true,
      result: method === 'worktrees.list' ? [] : null
    }))
    const focusedRuntimeSettings = { activeRuntimeEnvironmentId: 'env-win' } as AppState['settings']
    const cacheKey = 'local::repo1::pr-branch'
    const runtimeCacheKey = 'runtime:env-win::repo1::pr-branch'
    const prCacheKey = 'repo1::pr-branch'
    const runtimePRCacheKey = 'runtime:env-win::repo1::pr-branch'
    const legacyRepoPRCacheKey = 'repo1::pr-branch'
    const legacyPathPRCacheKey = '/repo1::pr-branch'
    const prData = {
      number: 456,
      title: 'Linked PR',
      state: 'open' as const,
      url: 'https://github.com/acme/repo/pull/456',
      checksStatus: 'success' as const,
      updatedAt: '2026-05-15T00:00:00.000Z',
      mergeable: 'MERGEABLE' as const
    }
    store.setState({
      settings: focusedRuntimeSettings,
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      hostedReviewCache: {
        [cacheKey]: {
          data: {
            provider: 'github',
            number: 456,
            title: 'Linked PR',
            state: 'open',
            url: 'https://github.com/acme/repo/pull/456',
            status: 'success',
            updatedAt: '2026-05-15T00:00:00.000Z',
            mergeable: 'MERGEABLE'
          },
          fetchedAt: Date.now()
        },
        [runtimeCacheKey]: {
          data: null,
          fetchedAt: Date.now()
        }
      },
      prCache: {
        [runtimePRCacheKey]: {
          data: { ...prData, title: 'Focused runtime PR' },
          fetchedAt: Date.now()
        },
        [legacyRepoPRCacheKey]: {
          data: { ...prData, title: 'Legacy repo-scoped PR' },
          fetchedAt: Date.now()
        },
        [legacyPathPRCacheKey]: {
          data: { ...prData, title: 'Legacy path-scoped PR' },
          fetchedAt: Date.now()
        }
      },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })

    expect(store.getState().worktreesByRepo.repo1[0]?.linkedPR).toBeNull()
    expect(store.getState().hostedReviewCache[cacheKey]).toBeUndefined()
    expect(store.getState().hostedReviewCache[runtimeCacheKey]?.data).toBeNull()
    expect(store.getState().prCache[prCacheKey]).toBeUndefined()
    expect(store.getState().prCache[runtimePRCacheKey]?.data?.title).toBe('Focused runtime PR')
    expect(store.getState().prCache[legacyRepoPRCacheKey]).toBeUndefined()
    expect(store.getState().prCache[legacyPathPRCacheKey]).toBeUndefined()
    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo1', 'pr-branch', {
      repoId: 'repo1',
      repoOwnerExecutionHostId: 'local',
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      force: true
    })
  })

  it('preserves linked GitLab MR fallback when removing linked GitHub PR metadata', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/review-branch',
      linkedPR: 456,
      linkedGitLabMR: 789
    })
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })

    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo1', 'review-branch', {
      repoId: 'repo1',
      repoOwnerExecutionHostId: 'local',
      linkedGitHubPR: null,
      linkedGitLabMR: 789,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      force: true
    })
  })
})
