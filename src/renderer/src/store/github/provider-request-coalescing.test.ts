import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubProjectTable } from '../../../../shared/github/project-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import type { FetchOptions } from './cache-model'
import { projectViewCacheKey, projectViewRequestKey } from './cache-identity'
import { inflightProjectViewRequests } from './request-coordination'
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

const projectViewRequest = {
  owner: 'acme',
  ownerType: 'organization' as const,
  projectNumber: 1,
  viewId: 'view-1'
}
const projectViewCacheKey1 = projectViewCacheKey('organization', 'acme', 1, 'view-1')

function projectTable(title: string): GitHubProjectTable {
  return {
    project: {
      id: 'project-1',
      owner: 'acme',
      ownerType: 'organization',
      number: 1,
      title,
      url: 'https://github.com/orgs/acme/projects/1'
    },
    selectedView: {
      id: 'view-1',
      number: 1,
      name: 'Table',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [],
      groupByFields: [],
      sortByFields: []
    },
    rows: [],
    totalCount: 0,
    parentFieldDropped: false
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

  it('never joins a weaker replacement and never waits out more than one', async () => {
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
    // Why: the strict callers must reach the bridge without waiting out the weaker
    // replacement too — the upgrade wait is bounded, so a repeating weaker refresh
    // can never starve them. They still share exactly one strict request.
    await vi.waitFor(() => expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3))
    expect(mockApi.gh.listWorkItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ noCache: true })
    )
    expect(strictSettled).not.toHaveBeenCalled()
    strict.resolve(workItems('strict'))
    await Promise.all(strictFollowers)
    forced.resolve(workItems('forced'))
    await expect(forcedFetch).resolves.toEqual(workItems('forced').items)
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3)
    expect(strictSettled).toHaveBeenCalledTimes(20)
    expect(strictSettled.mock.calls.every(([rows]) => rows[0].title === 'strict')).toBe(true)
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

  // Why: the bounded wait lets a force-only request (which still allows gh's own cache to answer)
  // run beside a noCache one. Whichever settles last used to win the cache unconditionally.
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
    await expect(forcedFetch).resolves.toEqual(workItems('gh-cached').items)

    expect(store.getState().getCachedWorkItems('repo-1', 24, '', '/repo')).toEqual(
      workItems('fresh').items
    )
    // Why: the stale payload must not be what isFresh hands back for the rest of the TTL either.
    await expect(store.getState().fetchWorkItems('repo-1', '/repo', 24, '')).resolves.toEqual(
      workItems('fresh').items
    )
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(3)
  })

  it('keeps a superseded check reply from rewinding the cached run state', async () => {
    const store = createTestStore()
    const plain = Promise.withResolvers<PRCheckDetail[]>()
    const noCacheOnly = Promise.withResolvers<PRCheckDetail[]>()
    const forcedOnly = Promise.withResolvers<PRCheckDetail[]>()
    mockApi.gh.prChecks
      .mockReturnValueOnce(plain.promise)
      .mockReturnValueOnce(noCacheOnly.promise)
      .mockReturnValue(forcedOnly.promise)
    const first = store.getState().fetchPRChecks('/repo', 1, 'main', 'sha')
    // Why: force and noCache are incomparable, so each waits out the plain request and the second
    // one then breaks out of the bounded wait while the first is still in flight.
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
    await expect(noCacheFetch).resolves.toEqual(older)

    expect(Object.values(store.getState().checksCache).map((entry) => entry.data)).toEqual([newer])
  })

  it('keeps a superseded project failure from stamping the known view key', async () => {
    const store = createTestStore()
    const weak = Promise.withResolvers<GetProjectViewTableResult>()
    const replacementWeak = Promise.withResolvers<GetProjectViewTableResult>()
    const forcedResult = Promise.withResolvers<GetProjectViewTableResult>()
    mockApi.gh.getProjectViewTable
      .mockReturnValueOnce(weak.promise)
      .mockReturnValueOnce(replacementWeak.promise)
      .mockReturnValue(forcedResult.promise)

    const first = store.getState().fetchProjectViewTable(projectViewRequest)
    const forcedFetch = store.getState().fetchProjectViewTable(projectViewRequest, { force: true })
    // Why: only a non-forced entry can be superseded mid-flight, and it has to appear in the
    // microtask after the first request clears the key — before the forced waiter re-checks it.
    const pending = inflightProjectViewRequests.get(
      projectViewRequestKey(projectViewRequest, 'local')
    )
    expect(pending).toBeDefined()
    let replacementFetch: Promise<GetProjectViewTableResult> | undefined
    void pending?.promise.then(() => {
      replacementFetch = store.getState().fetchProjectViewTable(projectViewRequest)
    })

    const staleError = { type: 'network_error' as const, message: 'first attempt offline' }
    weak.resolve({ ok: false, error: staleError })
    await first
    await vi.waitFor(() => expect(mockApi.gh.getProjectViewTable).toHaveBeenCalledTimes(3))
    expect(store.getState().projectViewCache[projectViewCacheKey1]).toMatchObject({
      error: staleError
    })

    forcedResult.resolve({ ok: true, data: projectTable('forced') })
    await expect(forcedFetch).resolves.toEqual({ ok: true, data: projectTable('forced') })
    const error = { type: 'network_error' as const, message: 'offline' }
    replacementWeak.resolve({ ok: false, error })
    await expect(replacementFetch).resolves.toEqual({ ok: false, error })

    expect(store.getState().projectViewCache[projectViewCacheKey1]).toMatchObject({
      data: projectTable('forced')
    })
    expect(store.getState().projectViewCache[projectViewCacheKey1].error).toBeUndefined()
  })
})
