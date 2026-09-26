import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { FetchOptions } from './cache-model'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'

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

const strongerWorkItemOptions: FetchOptions[] = [
  { force: true },
  { force: true, noCache: true },
  { force: true, requireComplete: true }
]

describe('GitHub provider request upgrade coalescing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it.each(strongerWorkItemOptions)('coalesces twenty work-item upgrades: %j', async (options) => {
    const store = createTestStore()
    const weak = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    const fresh = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(weak.promise).mockReturnValue(fresh.promise)
    const first = store.getState().fetchWorkItems('repo-1', '/repo', 24, '')
    const settled = vi.fn()
    const followers = Array.from({ length: 20 }, () =>
      store.getState().fetchWorkItems('repo-1', '/repo', 24, '', options).then(settled)
    )
    weak.resolve(workItems('weak'))
    await first
    await vi.waitFor(() =>
      expect(mockApi.gh.listWorkItems.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    expect(settled).not.toHaveBeenCalled()
    fresh.resolve(workItems('fresh'))
    await Promise.all(followers)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    expect(settled).toHaveBeenCalledTimes(20)
    expect(settled.mock.calls.every(([rows]) => rows[0].title === 'fresh')).toBe(true)
    expect(mockApi.gh.listWorkItems).toHaveBeenLastCalledWith({
      repoPath: '/repo',
      repoId: 'repo-1',
      limit: 24,
      query: undefined,
      ...(options.noCache ? { noCache: true } : {})
    })
  })

  it('rechecks every upgrade so strict callers cannot join a weaker replacement', async () => {
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
    const strictSettled = vi.fn()
    const strictFollowers = Array.from({ length: 20 }, () =>
      store
        .getState()
        .fetchWorkItems('repo-1', '/repo', 24, '', {
          force: true,
          noCache: true,
          requireComplete: true
        })
        .then(strictSettled)
    )
    weak.resolve(workItems('weak'))
    await first
    await vi.waitFor(() =>
      expect(mockApi.gh.listWorkItems.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    const callsBeforeForcedCompletes = mockApi.gh.listWorkItems.mock.calls.length
    forced.resolve(workItems('forced'))
    await expect(forcedFetch).resolves.toEqual(workItems('forced').items)
    await vi.waitFor(() =>
      expect(mockApi.gh.listWorkItems.mock.calls.length).toBeGreaterThanOrEqual(3)
    )
    expect(strictSettled).not.toHaveBeenCalled()
    strict.resolve(workItems('strict'))
    await Promise.all(strictFollowers)
    expect(callsBeforeForcedCompletes).toBe(2)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3)
    expect(strictSettled.mock.calls.every(([rows]) => rows[0].title === 'strict')).toBe(true)
    expect(mockApi.gh.listWorkItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ noCache: true })
    )
  })

  it('keeps an invalidated request from removing its replacement dedupe entry', async () => {
    const store = createTestStore()
    const stale = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    const fresh = Promise.withResolvers<ListWorkItemsResult<GitHubWorkItem>>()
    mockApi.gh.listWorkItems.mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise)
    const first = store.getState().fetchWorkItems('repo-1', '/repo', 24, '')
    store.getState().evictGitHubRepoCaches('repo-1', '/repo')
    const replacement = store.getState().fetchWorkItems('repo-1', '/repo', 24, '', { force: true })
    stale.resolve(workItems('stale'))
    await first
    const joined = store.getState().fetchWorkItems('repo-1', '/repo', 24, '', { force: true })
    fresh.resolve(workItems('fresh'))
    await expect(Promise.all([replacement, joined])).resolves.toEqual([
      workItems('fresh').items,
      workItems('fresh').items
    ])
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
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
    const followers = Array.from({ length: 20 }, () =>
      store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
        force: true,
        requireComplete: true
      })
    )
    const settled = Promise.allSettled(followers)
    weak.resolve(workItems('weak'))
    await first
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    mockApi.gh.listWorkItems.mockResolvedValue(workItems('recovered'))
    await expect(
      store.getState().fetchWorkItems('repo-1', '/repo', 24, '', {
        force: true,
        requireComplete: true
      })
    ).resolves.toEqual(workItems('recovered').items)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3)
  })

  it.each([{ force: true }, { noCache: true }])(
    'coalesces twenty check upgrades: %j',
    async (options) => {
      const store = createTestStore()
      const weak = Promise.withResolvers<PRCheckDetail[]>()
      const fresh = Promise.withResolvers<PRCheckDetail[]>()
      mockApi.gh.prChecks.mockReturnValueOnce(weak.promise).mockReturnValue(fresh.promise)
      const first = store.getState().fetchPRChecks('/repo', 1, 'main', 'sha')
      const settled = vi.fn()
      const followers = Array.from({ length: 20 }, () =>
        store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, options).then(settled)
      )
      weak.resolve([])
      await first
      await vi.waitFor(() =>
        expect(mockApi.gh.prChecks.mock.calls.length).toBeGreaterThanOrEqual(2)
      )
      expect(settled).not.toHaveBeenCalled()
      const checks: PRCheckDetail[] = [
        { name: 'fresh', status: 'completed', conclusion: 'success', url: null }
      ]
      fresh.resolve(checks)
      await Promise.all(followers)
      expect(mockApi.gh.prChecks).toHaveBeenCalledTimes(2)
      expect(settled).toHaveBeenCalledTimes(20)
      expect(settled.mock.calls.every(([rows]) => rows === checks)).toBe(true)
    }
  )
})
