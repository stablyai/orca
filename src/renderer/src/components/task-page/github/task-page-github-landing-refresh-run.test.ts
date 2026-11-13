import { expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import { runTaskPageGitHubLandingRefresh } from './task-page-github-landing-refresh-run'
import type { TaskPageGitHubLandingRefreshModel } from './use-task-page-github-landing-refresh'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0
}

const cachedPr: GitHubWorkItem = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Cached PR',
  state: 'open',
  url: 'https://github.com/acme/orca/pull/7',
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  author: 'octocat',
  repoId: 'repo-1'
}

it('keeps cached rows visible instead of the skeleton when a filter change hits a fully cached query', () => {
  const filtering = { value: true }
  const model = {
    fetchWorkItemsAcrossRepos: vi.fn(() => new Promise(() => {})),
    fetchWorkItemsNextPage: vi.fn(() => new Promise(() => {})),
    countWorkItemsAcrossRepos: vi.fn(() => new Promise(() => {})),
    getCachedWorkItems: () => [cachedPr],
    workItemsInvalidationNonce: 0,
    selectedRepos: [repo],
    selectedReposKey: 'repo-1',
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: 'is:pr is:open author:@me',
    taskRefreshNonce: 1,
    setTasksLoading: vi.fn(),
    setTasksRefreshing: vi.fn(),
    setTasksFiltering: (next: boolean) => {
      filtering.value = next
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
    githubResumeContextKey: 'filter-mine',
    setPages: vi.fn(),
    setCurrentPage: vi.fn(),
    pagesRef: { current: [] },
    currentPageRef: { current: 0 },
    githubResumeConsumedRef: { current: true },
    githubResumeContextRef: { current: 'filter-open' },
    pendingGithubScrollRestoreRef: { current: null },
    setPaginationLoading: vi.fn(),
    setLoadingTargetPage: vi.fn(),
    setCountedTotalPages: vi.fn(),
    setProvenPageLimit: vi.fn(),
    countedTotalPagesRef: { current: null },
    hardRefreshEpochRef: { current: 0 },
    retryingSourceKeys: new Set<string>(),
    setRetryingSourceKeys: vi.fn(),
    githubWorkItemMutationQueryKey: 'is:pr is:open author:@me',
    setLandingRequestKey: vi.fn()
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every field the landing run reads; unrelated page services are absent.
  runTaskPageGitHubLandingRefresh(model as unknown as TaskPageGitHubLandingRefreshModel)

  expect(model.fetchWorkItemsAcrossRepos).toHaveBeenCalled()
  expect(filtering.value).toBe(false)
})
