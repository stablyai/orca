// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostedReviewStore from '@/store/slices/hosted-review'

const refresh = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@/store/slices/hosted-review', async (importOriginal) => {
  const original = await importOriginal<typeof HostedReviewStore>()
  return {
    ...original,
    refreshHostedReviewCard: vi.fn(async () => {
      refresh.calls.push('hosted-review')
      return null
    })
  }
})

import { useChecksPanelManualRefresh } from './use-checks-panel-manual-refresh'

type RefreshInput = Parameters<typeof useChecksPanelManualRefresh>[0]

afterEach(() => {
  cleanup()
  refresh.calls.length = 0
})

describe('useChecksPanelManualRefresh ordering', () => {
  it('refreshes review identity before starting checks and comments, then clears loading', async () => {
    const refreshedPR = {
      number: 42,
      state: 'open',
      title: 'Current review',
      headSha: 'head-2',
      prRepo: { owner: 'orca', repo: 'app', host: 'github.com' }
    } as NonNullable<RefreshInput['pr']>
    const setChecksLoading: RefreshInput['setChecksLoading'] = vi.fn((loading) => {
      refresh.calls.push(`checks-loading:${String(loading)}`)
    })
    const setCommentsLoading: RefreshInput['setCommentsLoading'] = vi.fn((loading) => {
      refresh.calls.push(`comments-loading:${String(loading)}`)
    })
    const input: RefreshInput = {
      activeConnectionId: null,
      activeGitLabReview: null,
      activeWorktreeId: null,
      activeWorktreePath: null,
      activeWorktreePushTarget: null,
      asyncResultKeyRef: { current: 'cache::main::42' },
      branch: 'main',
      expireGitHubPRRefreshState: vi.fn(),
      fallbackGitHubPRNumber: null,
      fetchGitLabDetails: vi.fn(),
      fetchHostedReviewForBranch: vi.fn(),
      fetchPRChecks: vi.fn(async () => {
        refresh.calls.push('checks')
        return []
      }),
      fetchPRComments: vi.fn(async () => {
        refresh.calls.push('comments')
        return []
      }),
      fetchPRForBranch: vi.fn(async () => {
        refresh.calls.push('review')
        return refreshedPR
      }),
      gitStatusSnapshot: null,
      isCurrentAsyncResult: () => true,
      isFolder: false,
      isGitLabReviewContext: false,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGiteaPR: null,
      linkedGitLabMR: null,
      linkedPR: null,
      ownerSettings: null,
      panelContextKey: 'repo-1::worktree-1::main',
      panelContextKeyRef: { current: 'repo-1::worktree-1::main' },
      pollIntervalRef: { current: 30_000 },
      pr: refreshedPR,
      prCacheKey: 'cache',
      prNumber: 42,
      prevChecksRef: { current: '' },
      refreshInFlightRef: { current: false },
      refreshRequestKeyRef: { current: '' },
      repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<RefreshInput['repo']>,
      setChecks: vi.fn(),
      setChecksLoading,
      setComments: vi.fn(),
      setCommentsLoading,
      setEligibilityRefreshNonce: vi.fn(),
      setGitStatusSnapshot: vi.fn(),
      setIsRefreshing: vi.fn((loading) => {
        refresh.calls.push(`refreshing:${String(loading)}`)
      }),
      updateWorktreeGitIdentity: vi.fn()
    }
    const { result } = renderHook(() => useChecksPanelManualRefresh(input))

    await act(async () => result.current.handleRefresh())

    expect(refresh.calls).toEqual([
      'refreshing:true',
      'review',
      'hosted-review',
      'checks',
      'checks-loading:true',
      'comments-loading:true',
      'comments',
      'checks-loading:false',
      'comments-loading:false',
      'refreshing:false'
    ])
  })
})
