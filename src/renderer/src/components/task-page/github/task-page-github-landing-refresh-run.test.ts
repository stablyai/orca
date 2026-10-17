// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { runTaskPageGitHubLandingRefresh } from './task-page-github-landing-refresh-run'

type LandingRefreshModel = Parameters<typeof runTaskPageGitHubLandingRefresh>[0]
type FetchedRepo = { repoId: string }

const githubRepo: Repo = {
  id: 'github',
  path: '/repos/github',
  displayName: 'github',
  badgeColor: '',
  addedAt: 0,
  kind: 'git',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/stablyai/orca',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:stablyai/orca.git'
  }
}
const gitlabRepo: Repo = {
  ...githubRepo,
  id: 'gitlab',
  path: '/repos/gitlab',
  displayName: 'gitlab',
  gitRemoteIdentity: {
    canonicalKey: 'gitlab.com/group/project',
    remoteName: 'origin',
    remoteUrl: 'git@gitlab.com:group/project.git'
  }
}

function landingModel(githubTaskRepos: Repo[]) {
  const fetchWorkItemsAcrossRepos = vi.fn(async (repos: FetchedRepo[]) => ({
    items: [],
    // The real fan-out counts a repo it cannot resolve on GitHub as failed.
    failedCount: repos.filter((repo) => repo.repoId !== 'github').length,
    githubUnavailable: false
  }))
  const countWorkItemsAcrossRepos = vi.fn(async (_repos: FetchedRepo[]) => ({
    totalCount: 0,
    totalPages: 0
  }))
  const pagesRef: { current: unknown[][] } = { current: [[]] }
  const model = {
    fetchWorkItemsAcrossRepos,
    countWorkItemsAcrossRepos,
    fetchWorkItemsNextPage: vi.fn(),
    getCachedWorkItems: () => null,
    workItemsInvalidationNonce: 0,
    selectedRepos: [githubRepo, gitlabRepo],
    githubTaskRepos,
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: '',
    setTasksLoading: vi.fn(),
    setTasksRefreshing: vi.fn(),
    setTasksFiltering: vi.fn(),
    setTasksError: vi.fn(),
    setFailedCount: vi.fn(),
    setGithubUnavailable: vi.fn(),
    taskRefreshNonce: 0,
    lastFetchedNonceRef: { current: 0 },
    lastFetchedInvalidationNonceRef: { current: 0 },
    paginationGenerationRef: { current: 0 },
    landingGitHubRefreshKeysRef: { current: new Set<string>() },
    githubPerRepoPageLimit: 24,
    githubPageSize: 24,
    githubResumeContextKey: 'context',
    setPages: vi.fn(),
    setCurrentPage: vi.fn(),
    pagesRef,
    currentPageRef: { current: 0 },
    githubResumeConsumedRef: { current: true },
    githubResumeContextRef: { current: 'context' },
    pendingGithubScrollRestoreRef: { current: null },
    setPaginationLoading: vi.fn(),
    setLoadingTargetPage: vi.fn(),
    setCountedTotalPages: vi.fn(),
    setProvenPageLimit: vi.fn(),
    countedTotalPagesRef: { current: null },
    hardRefreshEpochRef: { current: 0 },
    retryingSourceKeys: new Set<string>(),
    setRetryingSourceKeys: vi.fn(),
    githubWorkItemMutationQueryKey: 'query'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The landing run reads only the fields stubbed above.
  const refreshModel = model as unknown as LandingRefreshModel
  return { model, run: () => runTaskPageGitHubLandingRefresh(refreshModel) }
}

describe('runTaskPageGitHubLandingRefresh', () => {
  it('hands gh only the GitHub-source repos, so skipped repos never count as failed', async () => {
    const { model, run } = landingModel([githubRepo])
    run()

    await vi.waitFor(() => expect(model.setTasksFiltering).toHaveBeenCalledTimes(1))
    const fetched = model.fetchWorkItemsAcrossRepos.mock.calls[0]?.[0] ?? []
    const counted = model.countWorkItemsAcrossRepos.mock.calls[0]?.[0] ?? []
    expect(fetched.map((repo) => repo.repoId)).toEqual(['github'])
    expect(counted.map((repo) => repo.repoId)).toEqual(['github'])
    expect(model.setFailedCount).toHaveBeenLastCalledWith(0)
  })

  it("clears the last selection's rows without querying when every selected repo is off GitHub", () => {
    const { model, run } = landingModel([])
    model.pagesRef.current = [[{ id: 'row-from-the-last-selection' }]]
    run()

    expect(model.fetchWorkItemsAcrossRepos).not.toHaveBeenCalled()
    expect(model.countWorkItemsAcrossRepos).not.toHaveBeenCalled()
    expect(model.pagesRef.current).toEqual([[]])
    expect(model.setPages).toHaveBeenCalledWith([[]])
    expect(model.setCurrentPage).toHaveBeenCalledWith(0)
    expect(model.setFailedCount).toHaveBeenCalledWith(0)
    expect(model.setTasksLoading).toHaveBeenCalledWith(false)
  })
})
