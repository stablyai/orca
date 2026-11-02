// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import {
  invalidateWorkItemDetailsCacheForKey,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from '../cache/work-item-details'
import { usePullRequestDetails } from './use-details'
import { syncPullRequestFileViewed } from './viewed-sync'

const lookup = vi.hoisted(() => vi.fn())
const setViewed = vi.hoisted(() => vi.fn())
vi.mock('@/lib/github-work-item-source-lookup', () => ({
  lookupGitHubWorkItemDetailsForSource: lookup
}))
vi.mock('@/components/github/github-work-item-comment-mutations', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPRFileViewedForRepo: setViewed
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const workItem = {
  id: 'pr:7',
  type: 'pr',
  number: 7,
  repoId: 'repo-1',
  title: 'PR',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/7',
  labels: []
} as unknown as GitHubWorkItem
const loaded = { item: workItem, body: 'Body', comments: [] } as unknown as GitHubWorkItemDetails
const comment = (id: string) =>
  ({ id, body: 'Thanks', author: 'me', createdAt: '' }) as unknown as PRComment
const renderDetails = () =>
  renderHook(() =>
    usePullRequestDetails({
      workItem,
      repoPath: '/repo',
      effectiveRepoId: 'repo-1',
      issueSourcePreference: undefined,
      canUseDetailsRepoContext: true
    })
  )

afterEach(() => {
  lookup.mockReset()
  setViewed.mockReset()
  workItemDetailsCache.clear()
})

describe('usePullRequestDetails reconciliation', () => {
  it('keeps a Viewed write landing on the shown files after a failed reread', async () => {
    lookup.mockResolvedValueOnce({
      item: workItem,
      body: 'Body',
      comments: [],
      pullRequestId: 'PR_7',
      files: [{ path: 'a.ts', viewerViewedState: 'UNVIEWED' }]
    } as unknown as GitHubWorkItemDetails)
    const { result } = renderHook(() =>
      usePullRequestDetails({
        workItem,
        repoPath: '/repo',
        effectiveRepoId: 'repo-1',
        issueSourcePreference: undefined,
        canUseDetailsRepoContext: true
      })
    )
    await waitFor(() => expect(result.current.detailsLoaded).toBe(true))
    lookup.mockRejectedValueOnce(new Error('offline'))
    act(() => invalidateWorkItemDetailsCacheForKey(result.current.detailsCacheKey!))
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))

    setViewed.mockResolvedValueOnce(true)
    await act(async () =>
      syncPullRequestFileViewed({
        canUseDetailsRepoContext: true,
        pullRequestId: result.current.details?.pullRequestId,
        workItem,
        effectiveRepoId: 'repo-1',
        path: 'a.ts',
        viewed: true,
        detailsCacheKey: result.current.detailsCacheKey,
        repoPath: '/repo',
        projectOrigin: undefined,
        setPendingViewedPaths: vi.fn()
      })
    )

    expect(result.current.detailsLoaded).toBe(true)
    expect(result.current.error).toBeNull()
    expect(result.current.details?.files?.[0]?.viewerViewedState).toBe('VIEWED')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('starts the owed reread when a comment lands in the same batch as the invalidation', async () => {
    lookup.mockResolvedValue(loaded)
    const { result } = renderDetails()
    await waitFor(() => expect(result.current.detailsLoaded).toBe(true))

    act(() => {
      invalidateWorkItemDetailsCacheForKey(result.current.detailsCacheKey!)
      result.current.appendOptimisticComment(comment('during-settlement'))
    })

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(result.current.details?.comments.map((c) => c.id)).toContain('during-settlement')
  })

  it('lands a running reread after a comment and an unrelated invalidation', async () => {
    lookup.mockResolvedValueOnce(loaded)
    const { result } = renderDetails()
    await waitFor(() => expect(result.current.detailsLoaded).toBe(true))
    const fresh = Promise.withResolvers<GitHubWorkItemDetails | null>()
    lookup.mockReturnValueOnce(fresh.promise)
    await act(async () => invalidateWorkItemDetailsCacheForKey(result.current.detailsCacheKey!))
    expect(lookup).toHaveBeenCalledTimes(2)

    await act(async () => result.current.appendOptimisticComment(comment('during-read')))
    act(() => {
      touchWorkItemDetailsCache('other-key', { details: loaded, fetchedAt: Date.now() })
      invalidateWorkItemDetailsCacheForKey('other-key')
    })
    const merged = { ...loaded, item: { ...workItem, state: 'merged' } }
    await act(async () => fresh.resolve(merged as GitHubWorkItemDetails))

    expect(result.current.details?.item.state).toBe('merged')
    expect(result.current.details?.comments.map((c) => c.id)).toContain('during-read')
  })
})
