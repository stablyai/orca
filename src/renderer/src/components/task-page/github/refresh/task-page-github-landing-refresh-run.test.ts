import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-items/work-item-types'
import { runTaskPageGitHubLandingRefresh } from './task-page-github-landing-refresh-run'
import type { TaskPageGitHubLandingRefreshModel } from './task-page-github-landing-refresh-model'

const QUERY = 'is:pr is:open author:@me'

function repo(id: string): Repo {
  return { id, path: `/repos/${id}`, displayName: id, badgeColor: '#000000', addedAt: 0 }
}

function pr(repoId: string, number: number): GitHubWorkItem {
  return {
    id: `pr:${number}`,
    type: 'pr',
    number,
    title: `PR ${number}`,
    state: 'open',
    url: `https://github.com/acme/${repoId}/pull/${number}`,
    labels: [],
    updatedAt: '2026-11-01T00:00:00Z',
    author: 'octocat',
    repoId
  }
}

type FetchResult = { items: GitHubWorkItem[]; failedCount: number; githubUnavailable: boolean }
type Deferred = { resolve: (result: FetchResult) => void }

// A filter click sets tasksFiltering, bumps the refresh nonce and changes the query; this is the landing run that follows.
function landAfterFilterChange(cache: Record<string, GitHubWorkItem[] | null>) {
  const state = { filtering: true, loading: false, refreshing: false, revalidating: false }
  const selectedRepos = Object.keys(cache).map(repo)
  const fetches: Deferred[] = []
  const pending = () => new Promise<never>(() => {})
  const pagesRef: { current: (GitHubWorkItem[] | null)[] } = { current: [] }
  const model = {
    fetchWorkItemsAcrossRepos: vi.fn(
      () =>
        new Promise<FetchResult>((resolve) => {
          fetches.push({ resolve })
        })
    ),
    fetchWorkItemsNextPage: vi.fn(pending),
    countWorkItemsAcrossRepos: vi.fn(pending),
    getCachedWorkItems: (repoId: string) => cache[repoId] ?? null,
    workItemsInvalidationNonce: 0,
    selectedRepos,
    selectedReposKey: selectedRepos.map((r) => r.id).join(','),
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: QUERY,
    taskRefreshNonce: 1,
    setTasksLoading: (next: boolean) => {
      state.loading = next
    },
    setTasksRefreshing: (next: boolean) => {
      state.refreshing = next
    },
    setTasksFiltering: (next: boolean) => {
      state.filtering = next
    },
    setGithubListRevalidating: (next: boolean) => {
      state.revalidating = next
    },
    setTasksError: vi.fn(),
    setFailedCount: vi.fn(),
    setGithubUnavailable: vi.fn(),
    lastFetchedNonceRef: { current: 0 },
    lastFetchedInvalidationNonceRef: { current: 0 },
    paginationGenerationRef: { current: 0 },
    landingGitHubRefreshKeysRef: { current: new Set<string>() },
    githubPerRepoPageLimit: 30,
    githubPageSize: 30,
    githubResumeContextKey: 'mine',
    setPages: (
      next:
        | (GitHubWorkItem[] | null)[]
        | ((previous: (GitHubWorkItem[] | null)[]) => (GitHubWorkItem[] | null)[])
    ) => {
      pagesRef.current = typeof next === 'function' ? next(pagesRef.current) : next
    },
    setCurrentPage: vi.fn(),
    pagesRef,
    currentPageRef: { current: 0 },
    githubResumeConsumedRef: { current: true },
    githubResumeContextRef: { current: 'open' },
    pendingGithubScrollRestoreRef: { current: null },
    setPaginationLoading: vi.fn(),
    setLoadingTargetPage: vi.fn(),
    setCountedTotalPages: vi.fn(),
    setProvenPageLimit: vi.fn(),
    countedTotalPagesRef: { current: null },
    hardRefreshEpochRef: { current: 0 },
    retryingSourceKeys: new Set<string>(),
    setRetryingSourceKeys: vi.fn(),
    githubWorkItemMutationQueryKey: QUERY,
    setLandingRequestKey: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every field the landing run reads.
  const landingModel = model as unknown as TaskPageGitHubLandingRefreshModel
  runTaskPageGitHubLandingRefresh(landingModel)
  const rows = () => pagesRef.current[0]?.map((row) => row.number)
  const answer = async (items: GitHubWorkItem[]) => {
    fetches[0]?.resolve({ items, failedCount: 0, githubUnavailable: false })
    await Promise.resolve()
    await Promise.resolve()
  }
  return { state, model, rows, answer }
}

describe('runTaskPageGitHubLandingRefresh after a filter change', () => {
  it('clears the skeleton only when every selected repo has the query cached', () => {
    const cached = landAfterFilterChange({ a: [pr('a', 7)], b: [pr('b', 9)] })
    const partial = landAfterFilterChange({ a: [pr('a', 7)], b: null })

    expect(cached.state).toEqual({
      filtering: false,
      loading: false,
      refreshing: true,
      revalidating: true
    })
    expect(cached.rows()).toEqual([9, 7])
    expect(partial.state).toEqual({
      filtering: true,
      loading: true,
      refreshing: true,
      revalidating: true
    })
  })

  it('keeps cached rows on screen while the forced refetch runs, then replaces them in place', async () => {
    const { state, model, rows, answer } = landAfterFilterChange({ a: [pr('a', 7), pr('a', 5)] })

    expect(model.fetchWorkItemsAcrossRepos).toHaveBeenCalledWith(
      expect.anything(),
      30,
      30,
      QUERY,
      expect.objectContaining({ force: true, noCache: true })
    )
    expect(rows()).toEqual([7, 5])
    expect(state.filtering).toBe(false)
    // Paging stays held until the refetch lands, since landing replaces every page.
    expect(state.revalidating).toBe(true)

    await answer([pr('a', 8), pr('a', 7)])

    expect(rows()).toEqual([8, 7])
    expect(state).toEqual({
      filtering: false,
      loading: false,
      refreshing: false,
      revalidating: false
    })
  })
})
