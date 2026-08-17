import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workItemsCacheKey } from './github'
import {
  createTestStore,
  githubSourceContext,
  mockApi,
  resetRemoteRuntimeMocks
} from './github-slice-test-harness'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

describe('createGitHubSlice.patchWorkItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('can scope patches to one repo when different repos have the same work-item id', () => {
    const store = createTestStore()
    const repoOneItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'Repo one PR'
    } as GitHubWorkItem
    const repoTwoItem = {
      id: 'pr:42',
      repoId: 'repo-2',
      type: 'pr',
      number: 42,
      title: 'Repo two PR'
    } as GitHubWorkItem

    store.setState({
      workItemsCache: {
        [workItemsCacheKey('repo-1', 20, '')]: { data: [repoOneItem], fetchedAt: 1 },
        [workItemsCacheKey('repo-2', 20, '')]: { data: [repoTwoItem], fetchedAt: 1 }
      }
    })

    store.getState().patchWorkItem('pr:42', { reviewRequests: [] }, 'repo-1')

    const state = store.getState()
    const repoOnePatched = state.workItemsCache[workItemsCacheKey('repo-1', 20, '')]?.data?.[0]
    const repoTwoPatched = state.workItemsCache[workItemsCacheKey('repo-2', 20, '')]?.data?.[0]
    expect(repoOnePatched).toMatchObject({
      repoId: 'repo-1',
      reviewRequests: []
    })
    expect(repoTwoPatched).toBe(repoTwoItem)
  })

  it('can scope patches to one GitHub task source when hosts share a repo id and work-item id', () => {
    const store = createTestStore()
    const firstSourceContext = githubSourceContext('runtime:first-host', 'repo-1')
    const secondSourceContext = githubSourceContext('runtime:second-host', 'repo-1')
    const firstItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'First host PR'
    } as GitHubWorkItem
    const secondItem = {
      id: 'pr:42',
      repoId: 'repo-1',
      type: 'pr',
      number: 42,
      title: 'Second host PR'
    } as GitHubWorkItem

    store.setState({
      workItemsCache: {
        [workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(firstSourceContext))]: {
          data: [firstItem],
          fetchedAt: 1
        },
        [workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(secondSourceContext))]: {
          data: [secondItem],
          fetchedAt: 1
        }
      }
    })

    store.getState().patchWorkItem('pr:42', { reviewRequests: [] }, 'repo-1', {
      sourceContext: firstSourceContext
    })

    const state = store.getState()
    const firstPatched =
      state.workItemsCache[
        workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(firstSourceContext))
      ]?.data?.[0]
    const secondPatched =
      state.workItemsCache[
        workItemsCacheKey('repo-1', 20, '', getTaskSourceCacheScope(secondSourceContext))
      ]?.data?.[0]
    expect(firstPatched).toMatchObject({
      title: 'First host PR',
      reviewRequests: []
    })
    expect(secondPatched).toBe(secondItem)
  })
})

describe('createGitHubSlice.fetchWorkItems cache identity', () => {
  const nestedSources = {
    issues: { owner: 'acme', repo: 'widgets' },
    prs: { owner: 'acme', repo: 'widgets' },
    originCandidate: { owner: 'acme', repo: 'widgets' },
    upstreamCandidate: { owner: 'acme-upstream', repo: 'widgets' }
  }

  function makeNestedWorkItem(
    overrides: Partial<GitHubWorkItem> & Pick<GitHubWorkItem, 'id' | 'number' | 'title'>
  ): Omit<GitHubWorkItem, 'repoId'> {
    return {
      type: 'pr',
      state: 'open',
      url: `https://github.com/acme/widgets/pull/${overrides.number}`,
      labels: ['bug', 'needs-review'],
      updatedAt: '2026-05-22T00:00:00Z',
      author: 'octocat',
      authorAvatarUrl: 'https://avatars.example/octocat.png',
      branchName: 'feature/nested',
      baseRefName: 'main',
      headSha: 'abc123def456',
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' },
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      reviewDecision: 'REVIEW_REQUIRED',
      reviewRequests: [
        { login: 'reviewer', name: 'Reviewer', avatarUrl: 'https://avatars.example/reviewer.png' }
      ],
      latestReviews: [
        { login: 'reviewer', state: 'COMMENTED', avatarUrl: 'https://avatars.example/reviewer.png' }
      ],
      assignees: [
        { login: 'assignee', name: 'Assignee', avatarUrl: 'https://avatars.example/assignee.png' }
      ],
      checksSummary: {
        state: 'pending',
        total: 4,
        passed: 1,
        failed: 0,
        pending: 3,
        neutral: 0
      },
      mergeable: 'MERGEABLE',
      ...overrides
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses the cache map, entry, and nested rows on a no-op force refetch', async () => {
    const store = createTestStore()
    const items = [
      makeNestedWorkItem({ id: 'pr:42', number: 42, title: 'First nested PR' }),
      makeNestedWorkItem({ id: 'pr:43', number: 43, title: 'Second nested PR' })
    ]
    mockApi.gh.listWorkItems.mockImplementation(() =>
      Promise.resolve({
        items: structuredClone(items),
        sources: structuredClone(nestedSources)
      })
    )

    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const cacheKey = workItemsCacheKey('repo-id', 24, '')
    const previousCache = store.getState().workItemsCache
    const previousEntry = previousCache[cacheKey]
    const previousRows = previousEntry?.data
    expect(previousRows).toHaveLength(2)
    expect(previousRows?.[0]?.labels).toEqual(['bug', 'needs-review'])
    expect(previousRows?.[0]?.assignees?.[0]?.login).toBe('assignee')
    expect(previousRows?.[0]?.reviewRequests?.[0]?.login).toBe('reviewer')
    expect(previousRows?.[0]?.prRepo).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'github.com'
    })
    expect(previousRows?.[0]?.checksSummary?.state).toBe('pending')

    now += 5_000
    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    const nextCache = store.getState().workItemsCache
    const nextEntry = nextCache[cacheKey]
    expect(nextCache).toBe(previousCache)
    expect(nextEntry).toBe(previousEntry)
    expect(nextEntry?.data).toBe(previousRows)
    expect(nextEntry?.data?.[0]).toBe(previousRows?.[0])
    expect(nextEntry?.data?.[1]).toBe(previousRows?.[1])
    expect(nextEntry?.sources).toBe(previousEntry?.sources)
    expect(nextEntry?.fetchedAt).toBe(now)
    expect(nextEntry?.fetchedAt).toBeGreaterThan(1_700_000_000_000)
  })

  it('writes a new entry when a nested reviewRequests login changes but reuses the sibling row', async () => {
    const store = createTestStore()
    const first = makeNestedWorkItem({ id: 'pr:42', number: 42, title: 'First nested PR' })
    const second = makeNestedWorkItem({ id: 'pr:43', number: 43, title: 'Second nested PR' })
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: structuredClone([first, second]),
      sources: structuredClone(nestedSources)
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const cacheKey = workItemsCacheKey('repo-id', 24, '')
    const previousCache = store.getState().workItemsCache
    const previousEntry = previousCache[cacheKey]
    const previousRows = previousEntry?.data
    expect(previousRows).toHaveLength(2)

    const changedFirst = structuredClone(first)
    const nextReviewer = changedFirst.reviewRequests?.[0]
    if (nextReviewer) {
      nextReviewer.login = 'reviewer-updated'
    }
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [changedFirst, structuredClone(second)],
      sources: structuredClone(nestedSources)
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    const nextCache = store.getState().workItemsCache
    const nextEntry = nextCache[cacheKey]
    expect(nextCache).not.toBe(previousCache)
    expect(nextEntry).not.toBe(previousEntry)
    expect(nextEntry?.data).not.toBe(previousRows)
    expect(nextEntry?.data?.[0]).not.toBe(previousRows?.[0])
    expect(nextEntry?.data?.[0]?.reviewRequests?.[0]?.login).toBe('reviewer-updated')
    expect(nextEntry?.data?.[1]).toBe(previousRows?.[1])
    expect(nextEntry?.sources).toBe(previousEntry?.sources)
  })
})
