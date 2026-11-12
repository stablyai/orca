import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubWorkItem,
  ListWorkItemsResult
} from '../../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'

import { createTestStore, mockApi, resetRemoteRuntimeMocks } from '../github-slice-test-harness'

function workItems(title: string): ListWorkItemsResult<GitHubWorkItem> {
  return {
    items: [
      {
        id: 'issue-1',
        type: 'issue',
        number: 1,
        title,
        state: 'open',
        url: 'https://example.test/1',
        labels: [],
        updatedAt: '2026-09-25T00:00:00Z',
        author: null,
        repoId: 'repo-1'
      }
    ],
    sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
  }
}

describe('GitHub provider request upgrade coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('rejects partial results for every complete-result waiter and allows a later retry', async () => {
    const store = createTestStore()
    const weak = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    const partial = {
      ...workItems('partial'),
      errors: { issues: { type: 'network_error' as const, message: 'offline' } }
    }
    mockApi.gh.listWorkItems.mockReturnValueOnce(weak.promise).mockResolvedValue(partial)
    const first = store.getState().fetchWorkItems('repo-1', '/repo', 24, '')
    const followers = Array.from({ length: 2 }, () =>
      store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
        force: true,
        requireComplete: true
      })
    )
    const settled = Promise.allSettled(followers)
    weak.resolve(workItems('weak'))
    await first
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true)

    mockApi.gh.listWorkItems.mockResolvedValue(workItems('recovered'))
    await expect(
      store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
        force: true,
        requireComplete: true
      })
    ).resolves.toEqual(workItems('recovered').items)
  })

  // Force-only may overlap noCache; settlement order must not let the weaker reply overwrite fresher results.
  it('keeps a late weaker work-item reply from burying the stronger result', async () => {
    const store = createTestStore()
    const weak = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    const forced = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    const strict = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    mockApi.gh.listWorkItems
      .mockReturnValueOnce(weak.promise)
      .mockReturnValueOnce(forced.promise)
      .mockReturnValue(strict.promise)
    const first = store.getState().fetchWorkItems('repo-1', '/repo', 24, '')
    const forcedFetch = store.getState().fetchWorkItems('repo-1', '/repo', 24, '', { force: true })
    const strictFetch = store
      .getState()
      .fetchWorkItems('repo-1', '/repo', 24, '', { force: true, noCache: true })
    weak.resolve(workItems('weak'))
    await first
    await vi.waitFor(() => expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3))

    strict.resolve(workItems('fresh'))
    await expect(strictFetch).resolves.toEqual(workItems('fresh').items)
    forced.resolve(workItems('gh-cached'))
    await expect(forcedFetch).resolves.toBeUndefined()

    expect(store.getState().getCachedWorkItems('repo-1', 24, '', '/repo')).toEqual(
      workItems('fresh').items
    )
    // Why: the stale payload must not be what isFresh hands back for the rest of the TTL either.
    await expect(store.getState().fetchWorkItems('repo-1', '/repo', 24, '')).resolves.toEqual(
      workItems('fresh').items
    )
  })

  it('keeps a superseded check reply from rewinding the cached or shown run state', async () => {
    const store = createTestStore()
    const plain = Promise.withResolvers<PRCheckDetail[]>()
    const noCacheOnly = Promise.withResolvers<PRCheckDetail[]>()
    const forcedOnly = Promise.withResolvers<PRCheckDetail[]>()
    mockApi.gh.prChecks
      .mockReturnValueOnce(plain.promise)
      .mockReturnValueOnce(noCacheOnly.promise)
      .mockReturnValue(forcedOnly.promise)
    const first = store.getState().fetchPRChecks('/repo', 1, 'main', 'sha')
    // Force/noCache are incomparable; both await plain work once, then may overlap.
    const noCacheFetch = store
      .getState()
      .fetchPRChecks('/repo', 1, 'main', 'sha', undefined, { noCache: true })
    const forcedFetch = store
      .getState()
      .fetchPRChecks('/repo', 1, 'main', 'sha', undefined, { force: true })
    plain.resolve([])
    await first
    await vi.waitFor(() => expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(3))

    const newer: PRCheckDetail[] = [
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ]
    const older: PRCheckDetail[] = [
      { name: 'build', status: 'in_progress', conclusion: null, url: null }
    ]
    forcedOnly.resolve(newer)
    await expect(forcedFetch).resolves.toEqual(newer)
    noCacheOnly.resolve(older)
    await expect(noCacheFetch).resolves.toEqual(newer)

    expect(Object.values(store.getState().checksCache).map((entry) => entry.data)).toEqual([newer])
  })
})
