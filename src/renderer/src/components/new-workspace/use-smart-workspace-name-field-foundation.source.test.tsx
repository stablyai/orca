import { linearIssueReadFixture } from '@/store/slices/linear-slice-test-harness'
// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { NormalizedWorkItemSourceSearchProps } from './smart-workspace-name-field-model'
import { useWorkItemSourceSearch } from './use-work-item-source-search'
import { referenceLinearIssue } from '../sidebar/workspace-reference-fixtures.test-support'
import { useWorkItemSourceFoundation } from './use-work-item-source-foundation'
import { useSmartWorkspaceSecondarySearches } from './use-smart-workspace-secondary-searches'
import { useSmartWorkspaceGitlabSearch } from './use-smart-workspace-gitlab-search'
import { useWorkItemSourcePresentation } from './use-work-item-source-presentation'

const mocks = vi.hoisted(() => ({
  readStatus: vi.fn(),
  listGitlabWorkItems: vi.fn(),
  readJiraSource: vi.fn(() => ({ intent: false })),
  state: {
    addRepo: vi.fn(),
    checkLinearConnection: vi.fn(),
    linearStatus: { connected: false, viewer: null, selectedWorkspaceId: 'focused-workspace' },
    linearStatusChecked: true,
    linearStatusContextKey: 'local#0',
    settings: null,
    preflightStatus: null,
    preflightStatusChecked: true,
    preflightStatusContextKey: 'test',
    refreshPreflightStatus: vi.fn(),
    listLinearIssues: vi.fn(async () => ({ items: [] })),
    searchLinearIssues: vi.fn<
      (query: string, limit: number, options: { workspaceId?: string }) => Promise<LinearIssue[]>
    >(async () => [])
  }
}))
vi.mock('@/runtime/runtime-linear-client', () => ({ linearStatus: mocks.readStatus }))
vi.mock('@/lib/gitlab-work-item-source-lookup', () => ({
  listGitLabWorkItemsForSource: mocks.listGitlabWorkItems,
  lookupGitLabWorkItemByPathForSource: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        ...mocks.state,
        listLinearIssues: (...args: Parameters<typeof mocks.state.listLinearIssues>) =>
          linearIssueReadFixture(() => mocks.state.listLinearIssues(...args)),
        searchLinearIssues: (...args: Parameters<typeof mocks.state.searchLinearIssues>) =>
          linearIssueReadFixture(() => mocks.state.searchLinearIssues(...args))
      }),
    { getState: () => mocks.state, subscribe: () => () => {} }
  )
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => ({}),
  localPreflightContextKey: () => 'test'
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./use-jira-source-connection', () => ({
  useJiraSourceConnection: () => ({ status: null, loaded: false })
}))
vi.mock('./use-jira-url-source', () => ({ useJiraUrlSource: mocks.readJiraSource }))
vi.mock('../use-jira-project-inventory', () => ({
  useJiraProjectInventory: () => ({ projects: [], connected: true, error: null, loading: false })
}))

const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'linear',
  projectId: 'project-1',
  hostId: 'runtime:saved-host',
  repoId: null,
  providerIdentity: null,
  accountLabel: null
}

function props(context?: TaskSourceContext): NormalizedWorkItemSourceSearchProps {
  return {
    repos: [],
    repoId: '',
    value: '',
    jiraSourceContext: null,
    linearSourceContext: context,
    disabled: false,
    textOnly: false,
    branchesEnabled: false,
    repoBackedSourcesDisabled: true,
    repoBackedSearchRepos: [],
    crossRepoSwitchTarget: 'task-source'
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('smart workspace explicit source connection', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.searchLinearIssues.mockResolvedValue([])
    mocks.state.listLinearIssues.mockResolvedValue({ items: [] })
    mocks.readStatus.mockResolvedValue({ connected: false, viewer: null })
    mocks.state.linearStatus = {
      connected: false,
      viewer: null,
      selectedWorkspaceId: 'focused-workspace'
    }
  })

  it('uses the resolved runtime repository default when a local repository has the same ID', () => {
    const localRepo: Repo = {
      id: 'same-id',
      path: '/local',
      displayName: 'Local',
      badgeColor: '',
      addedAt: 0,
      defaultJiraProject: { id: '10', key: 'LOC', name: 'Local', siteId: 'site-a' }
    }
    const selectedRepo: Repo = {
      ...localRepo,
      path: '/runtime',
      executionHostId: 'runtime:remote',
      defaultJiraProject: { id: '20', key: 'REM', name: 'Remote', siteId: 'site-b' }
    }
    const fieldProps = {
      ...props(),
      repos: [localRepo, selectedRepo],
      repoId: 'same-id',
      selectedRepo,
      jiraSourceContext: normalizeTaskSourceContext({
        provider: 'jira',
        projectId: 'repo:same-id',
        hostId: 'runtime:remote'
      })
    }
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    expect(result.current.selectedRepo).toBe(selectedRepo)
    expect(result.current.jiraProject).toEqual(selectedRepo.defaultJiraProject)
  })

  it('exposes Linear on a connected saved host while the focused runtime is disconnected', async () => {
    mocks.readStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'source-workspace'
    })
    const fieldProps = props(source)
    const { result } = renderHook(() => {
      const foundation = useWorkItemSourceFoundation(fieldProps)
      useSmartWorkspaceSecondarySearches({
        foundation,
        shouldQueryLinear: foundation.linearAvailable,
        linearQuery: 'launch',
        linearUrlIntent: null,
        linearUrlIntentOwnsInput: false,
        shouldQueryJira: false,
        jiraSearchQuery: null
      })
      return foundation
    })
    await waitFor(() =>
      expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(true)
    )
    expect(result.current.linearSourceContext).toBe(source)
    expect(result.current.linearStatus.connected).toBe(true)
    expect(mocks.state.searchLinearIssues).toHaveBeenCalledWith('launch', 12, {
      sourceContext: source,
      workspaceId: 'source-workspace'
    })
    expect(mocks.readStatus).toHaveBeenCalledWith(source)
    expect(mocks.state.checkLinearConnection).not.toHaveBeenCalled()
    expect(mocks.state.linearStatus.connected).toBe(false)
  })

  it('lists and searches all workspaces by default, with a composer-only override scoped to its source', async () => {
    const first = referenceLinearIssue({ id: 'first', workspaceId: 'first' })
    const second = referenceLinearIssue({ id: 'second', workspaceId: 'second' })
    mocks.readStatus.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'first'
    })
    mocks.state.searchLinearIssues.mockImplementation(async (_query, _limit, options) =>
      options.workspaceId === 'all'
        ? [first, second]
        : [first, second].filter((issue) => issue.workspaceId === options.workspaceId)
    )
    const fieldProps = props(source)
    const { result, rerender, unmount } = renderHook(
      ({ context, query }) => {
        return useWorkItemSourceSearch({
          ...fieldProps,
          linearSourceContext: context,
          value: query,
          defaultLinearWorkspaceId: 'all'
        })
      },
      { initialProps: { context: source, query: '' } }
    )
    act(() => result.current.setMode('linear'))
    await waitFor(() =>
      expect(mocks.state.listLinearIssues).toHaveBeenCalledWith(
        { kind: 'list', filter: 'assigned', limit: 12 },
        { sourceContext: source, workspaceId: 'all' }
      )
    )
    rerender({ context: source, query: 'launch' })
    await waitFor(() => expect(result.current.linearIssues).toEqual([first, second]))
    const pendingSecond = deferred<LinearIssue[]>()
    mocks.state.searchLinearIssues.mockReturnValueOnce(pendingSecond.promise)
    act(() => result.current.setLinearWorkspaceId('second'))
    expect(result.current.linearLoading).toBe(true)
    expect(result.current.searchResultRows).toEqual([])
    await act(async () => pendingSecond.resolve([second]))
    expect(result.current.searchResultRows).toMatchObject([{ kind: 'linear', issue: second }])
    expect(mocks.state.searchLinearIssues).toHaveBeenLastCalledWith('launch', 12, {
      sourceContext: source,
      workspaceId: 'second'
    })
    expect(result.current.linearStatus.selectedWorkspaceId).toBe('first')
    expect(mocks.state.linearStatus.selectedWorkspaceId).toBe('focused-workspace')

    act(() => result.current.setLinearWorkspaceId('all'))
    await waitFor(() => expect(result.current.linearIssues).toEqual([first, second]))
    const pendingAll = deferred<LinearIssue[]>()
    mocks.state.searchLinearIssues.mockReturnValueOnce(pendingAll.promise)
    rerender({ context: source, query: 'launch later' })
    await waitFor(() =>
      expect(mocks.state.searchLinearIssues).toHaveBeenLastCalledWith('launch later', 12, {
        sourceContext: source,
        workspaceId: 'all'
      })
    )
    expect(result.current.linearIssues).toEqual([first, second])
    expect(result.current.linearLoading).toBe(true)
    expect(result.current.searchResultRows).toMatchObject([
      { kind: 'linear', issue: first },
      { kind: 'linear', issue: second }
    ])
    act(() => result.current.setLinearWorkspaceId('first'))
    await waitFor(() => expect(result.current.linearIssues).toEqual([first]))
    const replacementSecond = deferred<LinearIssue[]>()
    mocks.state.searchLinearIssues.mockReturnValueOnce(replacementSecond.promise)
    act(() => result.current.setLinearWorkspaceId('second'))
    expect(result.current.searchResultRows).toEqual([])
    expect(result.current.linearLoading).toBe(true)
    await act(async () => replacementSecond.resolve([second]))
    await act(async () => pendingAll.resolve([first, second]))
    expect(result.current.searchResultRows).toMatchObject([{ kind: 'linear', issue: second }])
    expect(result.current.linearLoading).toBe(false)
    const otherHost: TaskSourceContext = { ...source, hostId: 'runtime:other-host' }
    const otherHostReplacement = deferred<LinearIssue[]>()
    mocks.state.searchLinearIssues.mockReturnValue(otherHostReplacement.promise)
    rerender({ context: otherHost, query: 'launch' })
    await waitFor(() =>
      expect(mocks.state.searchLinearIssues).toHaveBeenLastCalledWith('launch', 12, {
        sourceContext: otherHost,
        workspaceId: 'all'
      })
    )
    expect(result.current.linearIssues).toEqual([])
    expect(result.current.searchResultRows).toEqual([])
    expect(result.current.linearLoading).toBe(true)
    await act(async () => otherHostReplacement.resolve([first, second]))
    expect(result.current.linearIssues).toEqual([first, second])
    expect(result.current.linearLoading).toBe(false)
    const emptyReplacement = deferred<LinearIssue[]>()
    mocks.state.searchLinearIssues.mockReturnValueOnce(emptyReplacement.promise)
    rerender({ context: otherHost, query: 'nothing matches' })
    await waitFor(() =>
      expect(mocks.state.searchLinearIssues).toHaveBeenLastCalledWith('nothing matches', 12, {
        sourceContext: otherHost,
        workspaceId: 'all'
      })
    )
    expect(result.current.linearLoading).toBe(true)
    expect(result.current.searchResultRows).toMatchObject([
      { kind: 'linear', issue: first },
      { kind: 'linear', issue: second }
    ])
    await act(async () => emptyReplacement.resolve([]))
    expect(result.current.linearIssues).toEqual([])
    expect(result.current.searchResultRows).toEqual([])
    expect(result.current.linearLoading).toBe(false)
    unmount()
    const reopened = renderHook(() =>
      useWorkItemSourceFoundation({ ...props(source), defaultLinearWorkspaceId: 'all' })
    )
    expect(reopened.result.current.linearWorkspaceIdOverride).toBe('all')
  })

  it('shows GitLab workspace search rows without fetching an advertised probe page', async () => {
    const repo: Repo = {
      id: 'server-repo',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:remote'
    }
    const items: GitLabWorkItem[] = Array.from({ length: 12 }, (_, index) => ({
      id: `mr-${index + 1}`,
      type: 'mr',
      number: index + 1,
      title: `Merge request ${index + 1}`,
      state: 'opened',
      url: `https://gitlab.com/group/app/-/merge_requests/${index + 1}`,
      labels: [],
      updatedAt: '2026-10-01T00:00:00Z',
      author: null,
      repoId: repo.id
    }))
    mocks.listGitlabWorkItems.mockResolvedValue({
      items,
      page: 1,
      perPage: 12,
      totalCount: 0,
      totalPages: 2
    })
    const fieldProps = {
      ...props(),
      repos: [repo],
      repoId: repo.id,
      repoBackedSourcesDisabled: false,
      value: 'launch'
    }
    const { result } = renderHook(() => {
      const foundation = useWorkItemSourceFoundation(fieldProps)
      useSmartWorkspaceGitlabSearch({
        foundation,
        sourceQueryWithinLimit: true,
        shouldQueryGitlab: true
      })
      return useWorkItemSourcePresentation(foundation)
    })

    await waitFor(() => expect(result.current.searchResultRows).toHaveLength(items.length))
    expect(result.current.searchResultRows).toEqual(
      items.map((item) => ({
        kind: 'gitlab',
        value: `gitlab-${repo.id}-mr-${item.number}`,
        item
      }))
    )
    expect(result.current.loading).toBe(false)
    expect(mocks.listGitlabWorkItems).toHaveBeenCalledTimes(1)
    expect(mocks.listGitlabWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: repo.path,
        repoId: repo.id,
        state: 'opened',
        page: 1,
        perPage: 12,
        query: 'launch'
      })
    )
  })

  it('hides disconnected saved-host Linear even when the focused runtime is connected', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.readStatus.mockResolvedValue({ connected: false, viewer: null })
    const fieldProps = props(source)
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    await waitFor(() => expect(result.current.linearStatusChecked).toBe(true))
    expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(false)
    expect(result.current.linearStatus.connected).toBe(false)
  })

  it("reads Linear on the selected repo's host, not the focused one (#32924)", async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.readStatus.mockResolvedValue({ connected: false, viewer: null })
    const serverRepo: Repo = {
      id: 'server-repo',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:remote'
    }
    const fieldProps = { ...props(), repos: [serverRepo], repoId: serverRepo.id }
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    await waitFor(() => expect(result.current.linearStatusChecked).toBe(true))
    expect(mocks.readStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'linear', hostId: 'runtime:remote' })
    )
    expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(false)
    expect(mocks.state.checkLinearConnection).not.toHaveBeenCalled()
  })

  it("holds a pasted Linear URL while the repo host's status is still loading", async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.readStatus.mockReturnValue(new Promise(() => {}))
    const serverRepo: Repo = {
      id: 'server-repo',
      path: '/srv/app',
      displayName: 'app',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:remote'
    }
    const searchProps = {
      ...props(),
      repos: [serverRepo],
      repoId: serverRepo.id,
      value: 'https://linear.app/acme/issue/ENG-1/title'
    }
    const { result } = renderHook(() => useWorkItemSourceSearch(searchProps))
    await act(async () => {})
    expect(result.current.linearStatusChecked).toBe(false)
    expect(result.current.unresolvedLinearUrlIntent).toBe(true)
  })

  it('retains focused runtime status and avoids a new status read with no selected repo', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    const fieldProps = props()
    const { result } = renderHook(() => useWorkItemSourceFoundation(fieldProps))
    await act(async () => {})
    expect(result.current.availableModes.some((mode) => mode.id === 'linear')).toBe(true)
    expect(result.current.linearStatus).toBe(mocks.state.linearStatus)
    expect(mocks.readStatus).not.toHaveBeenCalled()
  })
  it('returns to Smart after losing a provider and does not resurrect its stale mode or rows', async () => {
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    mocks.state.searchLinearIssues.mockResolvedValue([referenceLinearIssue()])
    const searchProps = { ...props(), value: 'launch' }
    const { result, rerender } = renderHook(() => useWorkItemSourceSearch(searchProps))
    act(() => result.current.setMode('linear'))
    await waitFor(() => expect(result.current.rows.some((row) => row.kind === 'linear')).toBe(true))
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: false }
    rerender()
    await waitFor(() => expect(result.current.mode).toBe('smart'))
    expect(result.current.rows).toEqual([])
    mocks.state.searchLinearIssues.mockResolvedValue([])
    mocks.state.linearStatus = { ...mocks.state.linearStatus, connected: true }
    rerender()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.mode).toBe('smart')
    expect(result.current.rows).toEqual([])
  })

  it.each([false, true])(
    'allows Jira URL resolution only while sourceSelected=%s is false',
    (sourceSelected) => {
      const fieldProps = {
        ...props(),
        sourceSelected,
        value: 'https://company.atlassian.net/browse/ENG-1'
      }
      renderHook(() => useWorkItemSourceFoundation(fieldProps))
      expect(mocks.readJiraSource).toHaveBeenLastCalledWith(
        expect.objectContaining({ enabled: !sourceSelected })
      )
    }
  )
})
