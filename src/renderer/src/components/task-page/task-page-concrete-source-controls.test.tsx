// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useShallow } from 'zustand/react/shallow'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  closeTestStores,
  readDataFile,
  testState
} from '../../../../main/persistence/persistence-test-harness'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../ui/tooltip'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskPageStoreBindingsModel } from './use-task-page-store-bindings'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'
import { TaskPageGitHubIssueDialog } from './github/IssueDialog'
import { TaskPageGitHubModeControls } from './github/ModeControls'
import { TaskPageGitLabFilters } from './gitlab/Filters'
import { useTaskPageGitLabLoading } from './gitlab/use-task-page-gitlab-loading'
import { useTaskPageGitHubLandingRefresh } from './github/use-task-page-github-landing-refresh'
import { useTaskPageGitHubSearchPagination } from './github/use-task-page-github-search-pagination'
import { useTaskPageGitHubQuietRefresh } from './github/use-task-page-github-quiet-refresh'
import { useTaskPageGitHubIssueDraft } from './github/use-task-page-github-issue-draft'
import { useTaskPageGitHubIssueCreation } from './github/use-task-page-github-issue-creation'
import { assertTaskPageGitHubDialogStateAuthority } from './github/task-page-github-dialog-state-authority'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from './github/task-page-github-work-item-mutation-registry'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { getTaskPageRepoSourceContext } from './task-page-source-context'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../../main/telemetry/client', () => ({ track: vi.fn() }))
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-task-source-owner-'))
})

vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: () => null
}))

const rpc = vi.hoisted(() =>
  vi.fn(
    async (
      _target: unknown,
      _method: string,
      _params?: unknown,
      _options?: unknown
    ): Promise<unknown> => ({ items: [] })
  )
)
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: rpc
}))
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetTaskPageGitHubMutationRegistryForTests()
  vi.clearAllMocks()
})

it.each(['github', 'gitlab'] as const)(
  'retains the exact %s source from real picker/save/reload into provider dispatch and early warm',
  async (provider) => {
    const base: Repo = {
      id: 'same',
      path: '/local/app',
      executionHostId: 'local',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' }
    }
    const server: Repo = { ...base, path: '/server/app', executionHostId: 'runtime:server' }
    const projection = projectHostSetupProjectionFromRepos([base, server])
    let owner = createStore()
    owner.updateSettings({ defaultRepoSelection: ['local\0same'] })
    let saved = owner.getSettings()
    const persist = vi.fn(async (updates: Partial<GlobalSettings>) => {
      owner.updateSettings(updates)
      saved = owner.getSettings()
      return saved
    })
    Object.assign(window, {
      api: {
        settings: { set: persist, get: async () => owner.getSettings() },
        shell: { openUrl: vi.fn() },
        gl: { listIssues: vi.fn(async () => ({ items: [] })) }
      }
    })
    useAppStore.setState({
      repos: [base, server],
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: saved
    })
    const fetchPage = vi.fn(
      async (
        _repos: unknown[],
        _perRepo: number,
        _pageSize: number,
        _query: string,
        _page: number
      ) => ({ items: [], failedCount: 0, errorTypes: [] })
    )
    const initial = vi.fn(async () => ({ items: [], failedCount: 0, githubUnavailable: false }))
    const count = vi.fn(async () => ({ totalPages: 1 }))
    const workItem: GitHubWorkItem = {
      id: 'issue:1',
      repoId: 'same',
      type: 'issue',
      number: 1,
      title: 'Proof',
      state: 'closed',
      url: '',
      labels: [],
      updatedAt: '2026-10-29T00:00:00Z',
      author: null
    }
    const quietFetch = vi.fn(async () => ({
      items: [workItem],
      failedCount: 0,
      githubUnavailable: false
    }))
    const noop = vi.fn()
    let selected: Repo[] = []
    function Harness() {
      const state = useAppStore(
        useShallow((state) => ({
          repos: state.repos,
          settings: state.settings,
          updateSettings: state.updateSettings
        }))
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads these exact source/settings/status fields.
      const model = useTaskPageRepoSelection({
        ...state,
        pageData: {},
        linearStatus: {},
        jiraStatus: {}
      } as unknown as TaskPageStoreBindingsModel)
      selected = model.selectedRepos
      const [quietRefreshNonce, setQuietRefreshNonce] = useState(0)
      const [pages, setPages] = useState<GitHubWorkItem[][]>([[workItem]])
      const pagesRef = useRef(pages)
      pagesRef.current = pages
      const pagination = {
        ...model,
        taskResumeApplied: false,
        taskSearchInput: '',
        appliedTaskSearch: '',
        activeTaskPreset: 'all',
        activeGithubTaskKind: 'prs',
        githubSearchPersistReadyRef: useRef(false),
        paginationGenerationRef: useRef(0),
        pagesRef: useRef([]),
        currentPageRef: useRef(0),
        countedTotalPagesRef: useRef(null),
        paginationLoading: false,
        currentPage: 0,
        githubPerRepoPageLimit: 50,
        githubPageSize: 50,
        fetchWorkItemsNextPage: fetchPage,
        setTaskResumeState: noop,
        setAppliedTaskSearch: noop,
        setTasksFiltering: noop,
        setPages: noop,
        setCurrentPage: noop,
        setPaginationLoading: noop,
        setLoadingTargetPage: noop,
        setCountedTotalPages: noop,
        setProvenPageLimit: noop
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies all fields destructured by the production pagination hook.
      const page = useTaskPageGitHubSearchPagination(
        pagination as unknown as Parameters<typeof useTaskPageGitHubSearchPagination>[0]
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the complete production quiet-refresh inputs; the authority is confirmed through its real dialog boundary below.
      useTaskPageGitHubQuietRefresh({
        ...pagination,
        taskSource: provider,
        githubMode: 'items',
        quietRefreshNonce,
        setQuietRefreshNonce,
        pages,
        setPages,
        pagesRef,
        githubWorkItemMutationQueryKey: model.selectedReposKey,
        hardRefreshEpochRef: useRef(0),
        fetchWorkItemsAcrossRepos: quietFetch
      } as unknown as Parameters<typeof useTaskPageGitHubQuietRefresh>[0])
      useTaskPageGitHubLandingRefresh({
        ...pagination,
        taskSource: provider,
        taskResumeApplied: true,
        githubMode: 'items',
        fetchWorkItemsAcrossRepos: initial,
        getCachedWorkItems: () => null,
        countWorkItemsAcrossRepos: count,
        workItemsInvalidationNonce: 0,
        taskRefreshNonce: 0,
        githubResumeContextKey: model.selectedReposKey,
        githubWorkItemMutationQueryKey: model.selectedReposKey,
        lastFetchedNonceRef: useRef(0),
        lastFetchedInvalidationNonceRef: useRef(0),
        landingGitHubRefreshKeysRef: useRef(new Set()),
        githubResumeConsumedRef: useRef(false),
        githubResumeContextRef: useRef(''),
        pendingGithubScrollRestoreRef: useRef(null),
        hardRefreshEpochRef: useRef(0),
        retryingSourceKeys: new Set<string>(),
        setRetryingSourceKeys: noop,
        setTasksLoading: noop,
        setTasksRefreshing: noop,
        setTasksError: noop,
        setFailedCount: noop,
        setGithubUnavailable: noop
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every production landing/count dependency; empty real-shaped fetch results need no item mutation fixture.
      } as unknown as Parameters<typeof useTaskPageGitHubLandingRefresh>[0])
      useTaskPageGitLabLoading({
        selectedRepos: model.selectedRepos,
        selectedReposKey: model.selectedReposKey,
        primaryRepo: model.primaryRepo,
        taskSource: provider,
        gitlabView: 'issues',
        activeGitlabFilter: 'opened',
        gitlabRefreshNonce: 0,
        setGitlabItems: noop,
        setGitlabLoading: noop,
        setGitlabError: noop,
        setGitlabTodos: noop,
        setGitlabTodosLoading: noop
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real provider controls read these plus the production selection model; unrelated controls stay in their established inactive modes.
      const controls = {
        ...model,
        taskSource: provider,
        projectModeVisible: false,
        githubModeButtons: [],
        githubMode: 'items',
        activeGithubTaskKind: 'prs',
        getTaskPickerRepoHostLabel: (repo: Repo) =>
          repo.executionHostId === 'runtime:server' ? 'Server' : 'Local',
        gitlabView: 'issues',
        gitlabLoading: false,
        gitlabTodosLoading: false,
        gitLabIssueFilters: [],
        gitLabMRFilters: [],
        setGitlabFilter: noop,
        setGitlabRefreshNonce: noop,
        setGitlabView: noop,
        setTaskResumeState: noop
      } as unknown as TaskPageComposerActionsModel
      return (
        <TooltipProvider>
          {provider === 'github' ? (
            <TaskPageGitHubModeControls model={controls} />
          ) : (
            <TaskPageGitLabFilters model={controls} />
          )}
          <button onClick={() => void page.handleLoadNextPage(1)}>Next page</button>
          <button
            onClick={() => {
              setTaskPageGitHubMutationQueryKey(model.selectedReposKey)
              assertTaskPageGitHubDialogStateAuthority({
                repoId: 'same',
                itemId: workItem.id,
                state: 'closed',
                sourceContext: getTaskPageRepoSourceContext(model.primaryRepo, 'github')
              })
              setQuietRefreshNonce((value) => value + 1)
            }}
          >
            Revalidate task
          </button>
        </TooltipProvider>
      )
    }
    const user = userEvent.setup()
    const view = render(<Harness />)
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByTitle('Choose task source'))
    await user.click(screen.getByRole('button', { name: /Server \/server\/app/ }))
    await waitFor(() => expect(saved.defaultRepoSelection).toEqual(['runtime:server\0same']))
    expect(selected).toEqual([server])
    view.unmount()
    owner.flush()
    expect(readDataFile()).toHaveProperty('settings.defaultRepoSelection', ['runtime:server\0same'])
    await closeTestStores()
    owner = createStore()
    saved = owner.getSettings()
    await act(async () => {
      await useAppStore.getState().fetchSettings()
    })
    const restored = render(<Harness />)
    expect(selected).toEqual([server])
    if (provider === 'github') {
      const serverArgs = [
        expect.objectContaining({
          repoId: 'same',
          path: '/server/app',
          executionHostId: 'runtime:server',
          sourceContext: expect.objectContaining({ hostId: 'runtime:server', repoId: 'same' })
        })
      ]
      await waitFor(() =>
        expect(initial).toHaveBeenLastCalledWith(serverArgs, 50, 50, '', expect.anything())
      )
      expect(count).toHaveBeenLastCalledWith(serverArgs, '', 50, expect.anything())
      await user.click(screen.getByRole('button', { name: 'Next page' }))
      await waitFor(() => expect(fetchPage).toHaveBeenCalled())
      expect(fetchPage.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({
          repoId: 'same',
          path: '/server/app',
          executionHostId: 'runtime:server',
          sourceContext: expect.objectContaining({ hostId: 'runtime:server', repoId: 'same' })
        })
      ])
      await user.click(screen.getByRole('button', { name: 'Revalidate task' }))
      await waitFor(() =>
        expect(quietFetch).toHaveBeenCalledExactlyOnceWith(serverArgs, 50, 50, '', {
          force: true,
          noCache: true,
          requireComplete: true,
          allowStaleFallback: false
        })
      )
      const warm = vi.fn()
      act(() => useAppStore.setState({ prefetchWorkItems: warm }))
      useAppStore.getState().openTaskPage({ taskSource: 'github' })
      expect(warm).toHaveBeenCalledExactlyOnceWith(
        'same',
        '/server/app',
        expect.any(Number),
        expect.any(String),
        { sourceContext: expect.objectContaining({ hostId: 'runtime:server', repoId: 'same' }) }
      )
    } else {
      await waitFor(() => expect(rpc).toHaveBeenCalled())
      expect(rpc).toHaveBeenLastCalledWith(
        { kind: 'environment', environmentId: 'server' },
        'gitlab.listIssues',
        expect.objectContaining({ repo: 'id:same' }),
        expect.anything()
      )
    }
    // Offline exact intent cannot borrow the local twin; late hydration restores the source without rewriting settings.
    act(() => useAppStore.setState({ repos: [base] }))
    expect(selected).toEqual([])
    expect(saved.defaultRepoSelection).toEqual(['runtime:server\0same'])
    act(() => useAppStore.setState({ repos: [base, server] }))
    expect(selected).toEqual([server])
    // An explicit source stays a subset when new groups arrive; the null Select All intent follows late groups.
    const other: Repo = {
      ...base,
      id: 'other',
      path: '/other',
      upstream: { owner: 'org', repo: 'other' }
    }
    act(() => useAppStore.setState({ repos: [base, server, other] }))
    expect(selected).toEqual([server])
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('button', { name: 'All projects' }))
    await waitFor(() => expect(saved.defaultRepoSelection).toBeNull())
    expect(selected).toHaveLength(2)
    const late: Repo = {
      ...other,
      id: 'late',
      path: '/late',
      upstream: { owner: 'org', repo: 'late' }
    }
    act(() => useAppStore.setState({ repos: [base, server, other, late] }))
    expect(selected).toHaveLength(3)
    expect(saved.defaultRepoSelection).toBeNull()
    restored.unmount()
  }
)

it.each(['local', 'runtime:server'] as const)(
  'creates an issue from the real %s source picker and draft dialog through the selected provider owner',
  async (host) => {
    const local: Repo = {
      id: 'same',
      path: '/local/app',
      executionHostId: 'local',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' }
    }
    const server: Repo = { ...local, path: '/server/app', executionHostId: 'runtime:server' }
    const projection = projectHostSetupProjectionFromRepos([local, server])
    const created = { ok: true as const, number: 42, url: 'https://github.com/org/app/issues/42' }
    const createIssue = vi.fn(async () => created)
    const workItem = vi.fn(async () => null)
    const detail = vi.fn()
    rpc.mockImplementation(async (_target, method) =>
      method === 'github.createIssue' ? created : method === 'github.workItem' ? null : []
    )
    Object.assign(window, {
      api: {
        settings: { set: vi.fn(async (updates) => ({ ...getDefaultSettings(''), ...updates })) },
        gh: {
          createIssue,
          workItem,
          listLabels: vi.fn(async () => []),
          listAssignableUsers: vi.fn(async () => [])
        }
      }
    })
    useAppStore.setState({
      repos: [local, server],
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { ...getDefaultSettings(''), defaultRepoSelection: ['local\0same'] }
    })
    function Harness() {
      const state = useAppStore(
        useShallow((state) => ({
          repos: state.repos,
          settings: state.settings,
          updateSettings: state.updateSettings
        }))
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production selection only reads these settings/source fields.
      const selection = useTaskPageRepoSelection({
        ...state,
        pageData: {},
        linearStatus: {},
        jiraStatus: {}
      } as unknown as TaskPageStoreBindingsModel)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: issue draft reads settings/repos/selectedRepos from the production selection.
      const draft = useTaskPageGitHubIssueDraft({ ...state, ...selection } as unknown as Parameters<
        typeof useTaskPageGitHubIssueDraft
      >[0])
      const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the draft and all creation completion callbacks; the handler and visible dialog remain production code.
      const creation = useTaskPageGitHubIssueCreation({
        ...draft,
        setTaskRefreshNonce,
        setDialogWorkItem: vi.fn(),
        openGitHubDetailPage: detail
      } as unknown as Parameters<typeof useTaskPageGitHubIssueCreation>[0])
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provider controls and dialog consume these exact selection/draft/creation fields; unrelated providers are inactive.
      const controls = {
        ...selection,
        ...creation,
        taskSource: 'github',
        projectModeVisible: false,
        githubModeButtons: [],
        githubMode: 'items',
        activeGithubTaskKind: 'issues',
        getTaskPickerRepoHostLabel: (repo: Repo) =>
          repo.executionHostId === 'runtime:server' ? 'Server' : 'Local',
        perRepoSourceState: [],
        setIssueSourcePreference: vi.fn(),
        submitShortcutLabel: 'Cmd+Enter'
      } as unknown as TaskPageComposerActionsModel
      return (
        <TooltipProvider>
          <TaskPageGitHubModeControls model={controls} />
          <button onClick={() => draft.setNewIssueOpen(true)}>New issue</button>
          <TaskPageGitHubIssueDialog model={controls} />
          <output>{taskRefreshNonce}</output>
        </TooltipProvider>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    if (host === 'runtime:server') {
      await user.click(screen.getByRole('combobox'))
      await user.click(screen.getByTitle('Choose task source'))
      await user.click(screen.getByRole('button', { name: /Server \/server\/app/ }))
    }
    await user.click(screen.getByRole('button', { name: 'New issue' }))
    await user.type(screen.getByPlaceholderText('Short summary'), 'Concrete source')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))
    await waitFor(() =>
      expect(detail).toHaveBeenCalledWith(
        expect.objectContaining({ number: 42, repoId: 'same', title: 'Concrete source' })
      )
    )
    if (host === 'runtime:server') {
      expect(createIssue).not.toHaveBeenCalled()
      expect(rpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'server' },
        'github.createIssue',
        { repo: 'same', title: 'Concrete source', body: '', labels: [], assignees: [] },
        { timeoutMs: 65_000 }
      )
      expect(rpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'server' },
        'github.workItem',
        { repo: 'same', number: 42, type: 'issue' },
        { timeoutMs: 30_000 }
      )
    } else {
      expect(createIssue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          repoId: 'same',
          repoPath: '/local/app',
          title: 'Concrete source',
          sourceContext: expect.objectContaining({ hostId: 'local', repoId: 'same' })
        })
      )
      expect(workItem).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/local/app', number: 42 })
      )
      expect(rpc).not.toHaveBeenCalledWith(
        expect.anything(),
        'github.createIssue',
        expect.anything(),
        expect.anything()
      )
    }
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('1')
    expect(useAppStore.getState().newIssueDraft).toBeNull()
  }
)

it('shows and edits the selected concrete fork source in the actual issue dialog with same-ID host twins', async () => {
  const local: Repo = {
    id: 'same',
    path: '/local/app',
    executionHostId: 'local',
    displayName: 'App',
    badgeColor: '',
    addedAt: 0
  }
  const server: Repo = { ...local, path: '/server/app', executionHostId: 'runtime:server' }
  const upstream = { owner: 'org', repo: 'app', host: 'github.com' }
  const fork = { owner: 'server-fork', repo: 'app', host: 'github.com' }
  const setIssueSourcePreference = vi.fn()
  const noop = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog receives its complete fields; transport/provider loading is outside this visible source-picker boundary.
  const model = {
    selectedRepos: [local, server],
    newIssueTargetRepo: server,
    newIssueOpen: true,
    newIssueTitle: 'Proof',
    newIssueBody: '',
    newIssueLabels: [],
    newIssueAssignees: [],
    newIssueSubmitting: false,
    newIssueRepoId: 'runtime:server\0same',
    submitShortcutLabel: 'Cmd+Enter',
    perRepoSourceState: [
      {
        repoId: 'same',
        hostId: 'local',
        sources: { issues: upstream, originCandidate: upstream, upstreamCandidate: upstream }
      },
      {
        repoId: 'same',
        hostId: 'runtime:server',
        sources: { issues: fork, originCandidate: fork, upstreamCandidate: upstream }
      }
    ],
    newIssueRepoLabels: { data: [], loading: false, error: null },
    newIssueRepoAssignees: { data: [], loading: false, error: null },
    setIssueSourcePreference,
    setNewIssueOpen: noop,
    setNewIssueTitle: noop,
    setNewIssueBody: noop,
    setNewIssueLabels: noop,
    setNewIssueAssignees: noop,
    setNewIssueRepoId: noop,
    handleCreateNewIssue: noop
  } as unknown as TaskPageComposerActionsModel
  render(
    <TooltipProvider>
      <TaskPageGitHubIssueDialog model={model} />
    </TooltipProvider>
  )
  expect(screen.getByText('Filing in server-fork/app')).toBeTruthy()
  expect(screen.getByRole('group', { name: 'Issue source' })).toBeTruthy()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Origin' }))
  expect(setIssueSourcePreference).toHaveBeenCalledExactlyOnceWith(
    'same',
    '/server/app',
    'origin',
    'runtime:server'
  )
})

it('initializes the real store and keeps prefetch and page source-context exports on the same pure product', async () => {
  const { getTaskPageRepoSourceContext: pureSource } =
    await import('./task-page-repo-source-context')
  expect(getTaskPageRepoSourceContext).toBe(pureSource)
  const repo: Repo = {
    id: 'same',
    path: '/server/app',
    executionHostId: 'runtime:server',
    displayName: 'App',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const prefetchWorkItems = vi.fn()
  Object.assign(window, {
    api: { ui: { set: vi.fn(async () => {}), recordFeatureInteraction: vi.fn(async () => ({})) } }
  })
  useAppStore.setState({
    repos: [repo],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    settings: { ...getDefaultSettings(''), defaultRepoSelection: ['runtime:server\0same'] },
    prefetchWorkItems
  })
  useAppStore.getState().openTaskPage({ taskSource: 'github' }, { recordTasksInteraction: false })
  const source = getTaskPageRepoSourceContext(repo, 'github')
  expect(source).toMatchObject({
    provider: 'github',
    hostId: 'runtime:server',
    repoId: 'same',
    providerIdentity: { provider: 'github', owner: 'org', repo: 'app' }
  })
  expect(prefetchWorkItems).toHaveBeenCalledExactlyOnceWith(
    'same',
    '/server/app',
    expect.any(Number),
    expect.any(String),
    { sourceContext: source }
  )
  expect(
    getTaskPageRepoSourceContext(repo, 'gitlab', { host: 'gitlab.example', path: 'team/app' })
  ).toMatchObject({
    provider: 'gitlab',
    hostId: 'runtime:server',
    repoId: 'same',
    providerIdentity: { provider: 'gitlab', projectId: 'team/app' }
  })
  expect(getTaskPageRepoSourceContext(null, 'github')).toBeNull()
})
