// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createTestStore, resetRemoteRuntimeMocks } from '@/store/slices/github-slice-test-harness'
import { useSmartWorkspaceGithubSearch } from './use-smart-workspace-github-search'
import { useGitHubDuplicateIssueCandidates } from '@/components/github/github-duplicate-issue-candidates'
import * as githubLinks from '../../../../shared/github/links'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { Repo } from '../../../../shared/repo-types'
const holder = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: AppState) => T) => useStore(holder.store!, selector),
    { getState: () => holder.store!.getState() }
  )
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const repo: Repo = { id: 'repo', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 1 }
const item = (owner: string, number: number): GitHubWorkItem => ({
  id: `issue:${number}`,
  repoId: repo.id,
  type: 'issue',
  number,
  title: owner,
  url: `https://github.com/${owner}/r/issues/${number}`,
  state: 'open',
  author: null,
  labels: [],
  assignees: [],
  updatedAt: '2026-11-01T00:00:00Z'
})
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  holder.store = createTestStore()
  holder.store.setState({ repos: [repo] })
})
afterEach(cleanup)
it('offers duplicates only from the issue repository when fork buckets coexist', () => {
  holder.store!.setState({
    workItemsCache: {
      upstream: { data: [item('upstream', 12), item('upstream', 13)], fetchedAt: 1 },
      origin: { data: [item('fork', 12), item('fork', 14)], fetchedAt: 1 }
    }
  })
  const { result } = renderHook(() => useGitHubDuplicateIssueCandidates(item('fork', 10), true))
  expect(result.current.map((row) => row.url)).toEqual([item('fork', 14).url, item('fork', 12).url])
})
it('offers same-host duplicates to the unstamped issue New Issue opens', () => {
  holder.store!.setState({
    workItemsCache: { list: { data: [{ ...item('fork', 12), repoHostId: 'local' }], fetchedAt: 1 } }
  })
  const { result } = renderHook(() => useGitHubDuplicateIssueCandidates(item('fork', 13), true))
  expect(result.current.map((row) => row.number)).toEqual([12])
})
it('parses no other repository URL, and nothing on a write that leaves the cache alone', () => {
  const parse = vi.spyOn(githubLinks, 'parseGitHubIssueOrPRLink')
  const others = Array.from({ length: 100 }, (_, n) => ({ ...item('o', n + 20), repoId: 'other' }))
  holder.store!.setState({
    workItemsCache: {
      others: { data: others, fetchedAt: 1 },
      fork: { data: [item('fork', 12)], fetchedAt: 1 }
    }
  })
  const { result } = renderHook(() => useGitHubDuplicateIssueCandidates(item('fork', 10), true))
  expect(result.current.map((row) => row.number)).toEqual([12])
  // The picked issue and its one same-repository candidate.
  expect(parse).toHaveBeenCalledTimes(2)
  parse.mockClear()
  act(() => holder.store!.setState({ workItemsInvalidationNonce: 1 }))
  expect(parse).not.toHaveBeenCalled()
  parse.mockRestore()
})
it('re-reads an obsolete smart-search result instead of publishing or dropping it', async () => {
  const pending = Promise.withResolvers<readonly GitHubWorkItem[] | undefined>()
  const warm = [item('fork', 12)],
    current = [item('fork', 14)]
  const fetchWorkItems = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(current)
  const setGithubItems = vi.fn(),
    setGithubLoading = vi.fn()
  const foundation = {
    debouncedQuery: 'bug',
    disabled: false,
    handledCrossRepoUrlRef: { current: '' },
    repoSlugCacheRef: { current: new Map() },
    crossRepoSwitchTarget: 'project',
    repoBackedSearchTargets: [{ repo, githubSourceContext: null, gitlabSourceContext: null }],
    selectedRepo: repo,
    githubSourceContext: null,
    repos: [repo],
    getCachedWorkItems: () => warm,
    fetchWorkItems,
    fetchWorkItemsAcrossRepos: holder.store!.getState().fetchWorkItemsAcrossRepos,
    setGithubItems,
    setGithubLoading,
    setCrossRepoPrompt: vi.fn()
  }
  // SAFETY: this hook consumes only these foundation fields; other providers are not involved in GitHub search.
  renderHook(() =>
    useSmartWorkspaceGithubSearch({
      foundation: foundation as Parameters<typeof useSmartWorkspaceGithubSearch>[0]['foundation'],
      sourceQueryWithinLimit: true,
      shouldQueryGithub: true
    })
  )
  expect(setGithubItems).toHaveBeenLastCalledWith(warm)
  await act(async () => {
    pending.resolve(undefined)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  })
  expect(fetchWorkItems).toHaveBeenCalledTimes(2)
  expect(setGithubItems).toHaveBeenLastCalledWith(current)
  expect(setGithubLoading).toHaveBeenLastCalledWith(false)
})
