// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import {
  invalidateWorkItemDetailsCacheForKey,
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
})
