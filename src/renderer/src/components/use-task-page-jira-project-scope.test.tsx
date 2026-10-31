// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { useTaskPageJiraProjectScope } from './use-task-page-jira-project-scope'
import { useTaskPageJiraListState } from './use-task-page-jira-list-state'
import { useTaskPageStoreBindings } from './task-page/use-task-page-store-bindings'
import { useTaskPageRepoSelection } from './task-page/use-task-page-repo-selection'
import { useTaskPageRuntimeHosts } from './task-page/use-task-page-runtime-hosts'
import { useTaskPageSourceAvailability } from './task-page/use-task-page-source-availability'
import { useTaskPageProviderState } from './task-page/use-task-page-provider-state'
import { useTaskPageGitHubListState } from './task-page/github/use-task-page-github-list-state'
import { useTaskPageGitHubDetail } from './task-page/github/use-task-page-github-detail'
import { useTaskPageGitHubCacheReconciliation } from './task-page/github/use-task-page-github-cache-reconciliation'
import { useTaskPageGitHubIssueDraft } from './task-page/github/use-task-page-github-issue-draft'
import { useTaskPageDetailRouting } from './task-page/use-task-page-detail-routing'
import { useTaskPageLinearViewState } from './task-page/linear/use-task-page-linear-view-state'
const { readSavedFilters, mutateSavedFilters, readQuickFilters, writeQuickFilters } = vi.hoisted(
  () => ({
    readSavedFilters: vi.fn(),
    mutateSavedFilters: vi.fn(),
    readQuickFilters: vi.fn(),
    writeQuickFilters: vi.fn()
  })
)
vi.mock('@/runtime/runtime-jira-saved-filter-state', () => ({
  readJiraSavedFilterState: readSavedFilters,
  mutateJiraSavedFilters: mutateSavedFilters
}))
vi.mock('@/runtime/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: readQuickFilters,
  writeJiraQuickFilterState: writeQuickFilters
}))
const originalState = useAppStore.getState()
const project = { id: '10', key: 'ALP', name: 'Alpha', siteId: 'site-a' }
const filter = { id: 'saved', name: 'Saved work', jql: 'filter = 12345' }
const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  defaultJiraProject: project,
  kind: 'folder'
}
const sshProject = { ...project, id: '20', key: 'BRV', name: 'Bravo' }
const sshRepo: Repo = {
  ...repo,
  path: '/ssh/repo',
  connectionId: 'builder',
  defaultJiraProject: sshProject
}

function useComposedJiraListState() {
  const store = useTaskPageStoreBindings()
  const selection = useTaskPageRepoSelection(store)
  const hosts = useTaskPageRuntimeHosts(selection)
  const availability = useTaskPageSourceAvailability(hosts)
  const provider = useTaskPageProviderState(availability)
  const githubList = useTaskPageGitHubListState(provider)
  const githubDetail = useTaskPageGitHubDetail(githubList)
  const reconciled = useTaskPageGitHubCacheReconciliation(githubDetail)
  const draft = useTaskPageGitHubIssueDraft(reconciled)
  const routing = useTaskPageDetailRouting(draft)
  const linear = useTaskPageLinearViewState(routing)
  return useTaskPageJiraListState(linear)
}
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  localStorage.removeItem('orca.jira.has-workspace.v1')
})
beforeEach(() => {
  vi.resetAllMocks()
  readSavedFilters.mockResolvedValue({ filters: [filter], activeFilterId: filter.id })
  mutateSavedFilters.mockResolvedValue({ filters: [filter], activeFilterId: null })
  readQuickFilters.mockResolvedValue({ statuses: ['Blocked'] })
  writeQuickFilters.mockResolvedValue({ statuses: [] })
})
describe('repository-scoped Jira Tasks', () => {
  it('uses an explicit folder repository default and allows the All-project override', () => {
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope([repo], [], 'repo', 'local', 'all')
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
    act(() => result.current.setJiraProjectFilter(null))
    expect(result.current.jiraProjectFilter).toBeNull()
    expect(repo.defaultJiraProject).toEqual(project)
  })
  it('does not apply another site or execution host’s project mapping', () => {
    const initialProps: { host: ExecutionHostId; site: string } = { host: 'local', site: 'site-b' }
    const { result, rerender } = renderHook(
      ({ host, site }) => useTaskPageJiraProjectScope([repo], [repo], 'repo', host, site),
      { initialProps }
    )
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ host: 'runtime:remote', site: 'site-a' })
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ host: 'local', site: 'site-a' })
    expect(result.current.jiraProjectFilter).toEqual(project)
  })

  it('uses the explicitly selected SSH owner before a duplicate preselected repository ID', () => {
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope([repo, sshRepo], [sshRepo], repo.id, 'local', project.siteId)
    )
    expect(result.current.jiraProjectFilter).toEqual(sshProject)
  })

  it('keeps a unique preselection ahead of a different previously selected repository', () => {
    const previouslySelected: Repo = { ...repo, id: 'previous', defaultJiraProject: sshProject }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope(
        [repo, previouslySelected],
        [previouslySelected],
        repo.id,
        'local',
        project.siteId
      )
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
  })

  it('falls back to the single selected repository when the preselected ID is missing', () => {
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope([repo], [repo], 'missing', 'local', project.siteId)
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
  })

  it('falls back when a unique different-ID preselection belongs to another Jira account', () => {
    const runtimeRepo: Repo = { ...repo, id: 'remote', executionHostId: 'runtime:remote' }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope(
        [repo, runtimeRepo],
        [repo],
        runtimeRepo.id,
        'local',
        project.siteId
      )
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
  })

  it('does not borrow a compatible default when the explicit matching owner uses another account', () => {
    const runtimeRepo: Repo = { ...repo, executionHostId: 'runtime:remote' }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope(
        [repo, runtimeRepo],
        [runtimeRepo],
        repo.id,
        'local',
        project.siteId
      )
    )
    expect(result.current.jiraProjectFilter).toBeNull()
  })

  it('does not use a different selected repository to resolve ambiguous preselection', () => {
    const previouslySelected: Repo = { ...repo, id: 'previous' }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope(
        [repo, sshRepo, previouslySelected],
        [previouslySelected],
        repo.id,
        'local',
        project.siteId
      )
    )
    expect(result.current.jiraProjectFilter).toBeNull()
  })

  it('resets the All-project override when the same repository ID changes execution owner', () => {
    const initialProps: { selected: readonly Repo[] } = { selected: [repo] }
    const { result, rerender } = renderHook(
      ({ selected }) =>
        useTaskPageJiraProjectScope([repo, sshRepo], selected, undefined, 'local', project.siteId),
      { initialProps }
    )
    expect(result.current.jiraProjectFilter).toEqual(project)
    act(() => result.current.setJiraProjectFilter(null))
    expect(result.current.jiraProjectFilter).toBeNull()
    rerender({ selected: [sshRepo] })
    expect(result.current.jiraProjectFilter).toEqual(sshProject)
  })

  it.each([{ selected: [] }, { selected: [repo, sshRepo] }])(
    'refuses an ambiguous preselected repository ID without a single selected owner (%#)',
    ({ selected }) => {
      const { result } = renderHook(() =>
        useTaskPageJiraProjectScope([repo, sshRepo], selected, repo.id, 'local', project.siteId)
      )
      expect(result.current.jiraProjectFilter).toBeNull()
    }
  )

  it('does not use the Jira account owner to choose between local and runtime repositories', () => {
    const runtimeRepo: Repo = { ...repo, executionHostId: 'runtime:remote' }
    const { result } = renderHook(() =>
      useTaskPageJiraProjectScope([repo, runtimeRepo], [], repo.id, 'local', project.siteId)
    )
    expect(result.current.jiraProjectFilter).toBeNull()
  })

  it('keeps duplicate execution owners ambiguous through the actual Tasks list-state pipeline', () => {
    const localGitRepo: Repo = { ...repo, kind: 'git' }
    const sshGitRepo: Repo = { ...sshRepo, kind: 'git' }
    useAppStore.setState({
      settings: null,
      repos: [localGitRepo, sshGitRepo],
      taskPageData: { taskSource: 'jira', preselectedRepoId: repo.id },
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'all' },
      jiraStatusChecked: true,
      jiraStatusContextKey: getProviderRuntimeContextKey(null)
    })
    const { result } = renderHook(useComposedJiraListState)
    expect(result.current.selectedRepos).toEqual([localGitRepo, sshGitRepo])
    expect(result.current.accountBackedTaskSourceHostId).toBe('local')
    expect(result.current.jiraProjectFilter).toBeNull()
  })

  it('keeps linked mode, saved filters, and the project override in the composed list state', async () => {
    localStorage.removeItem('orca.jira.has-workspace.v1')
    useAppStore.setState({
      settings: null,
      repos: [repo],
      taskPageData: { taskSource: 'jira', preselectedRepoId: repo.id },
      jiraStatus: { connected: true, viewer: null, selectedSiteId: 'all' },
      jiraStatusChecked: true,
      jiraStatusContextKey: getProviderRuntimeContextKey(null)
    })
    const { result } = renderHook(useComposedJiraListState)
    act(() => result.current.setTaskResumeApplied(true))
    await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
    await waitFor(() => expect(result.current.jiraQuickFiltersReady).toBe(true))
    expect(readSavedFilters).toHaveBeenCalledWith({ kind: 'local' })
    expect(result.current.jiraActiveSavedFilterId).toBe(filter.id)
    expect(result.current.appliedJiraSearch).toBe(filter.jql)
    expect(result.current.selectedJiraStatuses).toEqual(['Blocked'])
    expect(result.current.jiraProjectFilter).toEqual(project)
    act(() => result.current.setJiraProjectFilter(null))
    act(() => result.current.setJiraHasWorkspace(true))
    expect(result.current.jiraHasWorkspace).toBe(true)
    expect(result.current.jiraProjectFilter).toBeNull()
    await act(async () => result.current.clearJiraSavedFilterSelection())
    expect(mutateSavedFilters).toHaveBeenCalledWith({ kind: 'local' }, { kind: 'select', id: null })
    expect(result.current.jiraActiveSavedFilterId).toBeNull()
    expect(result.current.jiraProjectFilter).toBeNull()
    act(() => result.current.setJiraHasWorkspace(false))
    expect(result.current.jiraHasWorkspace).toBe(false)
    expect(result.current.jiraProjectFilter).toBeNull()
    expect(repo.defaultJiraProject).toEqual(project)
    expect(result.current.selectedJiraStatuses).toEqual(['Blocked'])
  })
})
