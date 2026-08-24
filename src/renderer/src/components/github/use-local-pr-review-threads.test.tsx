// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkItemDetailsCacheKey,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from '@/components/pull-request-page/cache/work-item-details'
import type { GitHubWorkItemDetails } from '../../../../shared/github/work-item-types'
import { useLocalPRReviewThreads } from './use-local-pr-review-threads'

const lookupGitHubWorkItemDetailsForSource = vi.hoisted(() => vi.fn())
vi.mock('@/lib/github-work-item-source-lookup', () => ({ lookupGitHubWorkItemDetailsForSource }))

const storeState = vi.hoisted(() => ({
  worktreesByRepo: {} as Record<string, unknown[]>,
  repos: [] as { id: string; path: string; issueSourcePreference?: string }[],
  hostedReviewCache: {} as Record<string, { data?: { provider: string; number: number } }>
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof storeState) => unknown) => selector(storeState)
}))

function worktree(linkedPR: number | null): Record<string, unknown> {
  return { id: 'repo-1::/wt', repoId: 'repo-1', path: '/wt', branch: 'refs/heads/feat/x', linkedPR }
}

function details(): GitHubWorkItemDetails {
  return {
    item: { id: 'PR_1', repoId: 'repo-1' } as unknown as GitHubWorkItemDetails['item'],
    body: '',
    headSha: 'headsha',
    comments: [
      {
        id: 1,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'inline',
        createdAt: '2026-04-01T00:00:00Z',
        url: 'u',
        path: 'a.ts',
        threadId: 'T1',
        line: 2
      },
      {
        id: 2,
        author: 'bob',
        authorAvatarUrl: '',
        body: 'conversation comment without a path',
        createdAt: '2026-04-01T00:00:00Z',
        url: 'u'
      }
    ]
  }
}

const cacheKey = getWorkItemDetailsCacheKey({
  repoPath: '/repo',
  repoId: 'repo-1',
  issueSourcePreference: undefined,
  type: 'pr',
  number: 7
})

beforeEach(() => {
  workItemDetailsCache.clear()
  lookupGitHubWorkItemDetailsForSource.mockReset()
  storeState.worktreesByRepo = { 'repo-1': [worktree(7)] }
  storeState.repos = [{ id: 'repo-1', path: '/repo' }]
  storeState.hostedReviewCache = {}
})

describe('useLocalPRReviewThreads', () => {
  it('returns inert state and fetches nothing without a linked PR', () => {
    storeState.worktreesByRepo = { 'repo-1': [worktree(null)] }
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    expect(result.current.prNumber).toBeNull()
    expect(result.current.comments).toEqual([])
    expect(lookupGitHubWorkItemDetailsForSource).not.toHaveBeenCalled()
  })

  it('fetches nothing when disabled', () => {
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', false))
    expect(result.current.prNumber).toBeNull()
    expect(lookupGitHubWorkItemDetailsForSource).not.toHaveBeenCalled()
  })

  it('fetches details for the linked PR and exposes only path-carrying comments', async () => {
    lookupGitHubWorkItemDetailsForSource.mockResolvedValue(details())
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    expect(lookupGitHubWorkItemDetailsForSource).toHaveBeenCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      number: 7,
      type: 'pr'
    })
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
    expect(result.current.comments[0]).toMatchObject({ id: 1, path: 'a.ts' })
    expect(result.current.prHeadSha).toBe('headsha')
    expect(result.current.prNumber).toBe(7)
  })

  it('reuses a fresh shared cache entry instead of refetching', () => {
    touchWorkItemDetailsCache(cacheKey, { details: details(), fetchedAt: Date.now() })
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    expect(lookupGitHubWorkItemDetailsForSource).not.toHaveBeenCalled()
    expect(result.current.comments).toHaveLength(1)
  })

  it('falls back to the hosted-review cache when linkedPR is unset', async () => {
    storeState.worktreesByRepo = { 'repo-1': [worktree(null)] }
    storeState.hostedReviewCache = {
      'local::repo-1::feat/x': { data: { provider: 'github', number: 7 } }
    }
    lookupGitHubWorkItemDetailsForSource.mockResolvedValue(details())
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    expect(result.current.prNumber).toBe(7)
    await waitFor(() => expect(result.current.comments).toHaveLength(1))
  })

  it('refetches on window focus only once the cache is stale', async () => {
    touchWorkItemDetailsCache(cacheKey, { details: details(), fetchedAt: Date.now() })
    lookupGitHubWorkItemDetailsForSource.mockResolvedValue(details())
    renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(lookupGitHubWorkItemDetailsForSource).not.toHaveBeenCalled())
    touchWorkItemDetailsCache(cacheKey, { details: details(), fetchedAt: 0 })
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(lookupGitHubWorkItemDetailsForSource).toHaveBeenCalledTimes(1))
  })

  it('keeps previously painted details when a refresh fails', async () => {
    touchWorkItemDetailsCache(cacheKey, { details: details(), fetchedAt: 0 })
    lookupGitHubWorkItemDetailsForSource.mockRejectedValue(new Error('rate limited'))
    const { result } = renderHook(() => useLocalPRReviewThreads('repo-1::/wt', true))
    await waitFor(() => expect(workItemDetailsCache.get(cacheKey)?.error).toBe('rate limited'))
    expect(result.current.comments).toHaveLength(1)
  })
})
