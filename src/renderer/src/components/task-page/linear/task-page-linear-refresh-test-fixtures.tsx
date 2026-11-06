import { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import type * as ReactModule from 'react'
import type { LinearEditState } from '../../linear-item-drawer-types'
import { useCallback } from 'react'
import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { LinearIssueTextEditor } from '../../LinearIssueTextEditor'
import { useLinearIssueEditController } from '../../linear-item-drawer-edit-controller'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { useStore } from 'zustand'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { useTaskPageLinearCollectionEffectsPrelude } from './use-task-page-linear-collection-effects'
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { createTestStore, issue } from '../../../store/slices/linear-slice-test-harness'
import { clearLinearRequestMaps } from '../../../store/slices/linear/linear-slice-request-state'
import { useTaskPageLinearListSelectionPrelude } from './use-task-page-linear-list-selection'
import { useTaskPageLinearListEffects } from './use-task-page-linear-list-effects'

const deferredIssueSetters = vi.hoisted(() => {
  const updates: VoidFunction[] = []
  return { enabled: false, updates }
})
vi.mock('react', async (original) => {
  const actual = await original<typeof ReactModule>()
  return {
    ...actual,
    useReducer<S, A>(reducer: (previous: S, action: A) => S, initial: S) {
      const [value, dispatch] = actual.useReducer(reducer, initial)
      const send = actual.useCallback((action: A) => {
        if (
          deferredIssueSetters.enabled &&
          typeof initial === 'object' &&
          initial !== null &&
          'whole' in initial
        ) {
          deferredIssueSetters.updates.push(() => dispatch(action))
        } else {
          dispatch(action)
        }
      }, [])
      return [value, send] as const
    }
  }
})
export { deferredIssueSetters }

const active = vi.hoisted(() => ({ store: vi.fn<() => Store>() }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: ReturnType<Store['getState']>) => unknown) =>
      useStore(active.store(), selector),
    {
      getState: () => active.store().getState(),
      subscribe: (...args: Parameters<Store['subscribe']>) => active.store().subscribe(...args)
    }
  )
}))

vi.mock('@/i18n/i18n', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (match, key) => values?.[key] ?? match)
}))

const reads: {
  list: Mock
  search: Mock
  project: Mock
  view: Mock
  detail: Mock
  update: Mock
  create: Mock
  projects: Mock
  connect: Mock
  test: Mock
  select: Mock
} = vi.hoisted(() => ({
  list: vi.fn(),
  search: vi.fn(),
  project: vi.fn(),
  view: vi.fn(),
  detail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  projects: vi.fn(),
  connect: vi.fn(),
  test: vi.fn(),
  select: vi.fn()
}))

const accountViewer = vi.hoisted(() => ({
  displayName: 'User',
  email: null,
  organizationName: 'Acme'
}))

vi.mock('@/runtime/runtime-linear-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearTestConnection: (...args: unknown[]) => reads.test(...args),
  linearSelectWorkspace: (...args: unknown[]) => reads.select(...args),
  linearDisconnect: async () => {},
  linearConnect: (...args: unknown[]) => reads.connect(...args),
  linearStatus: async () => ({ connected: true, viewer: accountViewer, selectedWorkspaceId: 'w' }),
  linearListIssues: (...args: unknown[]) => reads.list(...args),
  linearSearchIssues: (...args: unknown[]) => reads.search(...args)
}))

vi.mock('@/runtime/runtime-linear-project-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearListProjects: reads.projects,
  linearTeamStates: async () => [{ id: 'done', name: 'Done', type: 'completed', color: '#888888' }],
  linearListProjectIssues: (...args: unknown[]) => reads.project(...args),
  linearListCustomViewIssues: (...args: unknown[]) => reads.view(...args)
}))

vi.mock('@/runtime/runtime-linear-issue-mutations', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  linearGetIssue: reads.detail,
  linearIssueComments: async () => [],
  linearUpdateIssue: reads.update,
  linearCreateIssue: reads.create
}))

vi.mock('@/hooks/useIssueMetadata', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useTeamLabels: () => ({ data: [{ id: 'bug', name: 'Bug' }], loading: false }),
  useTeamMembers: () => ({ data: [], loading: false }),
  clearLinearMetadataCache: vi.fn(),
  useTeamStates: () => ({
    data: [{ id: 'done', name: 'Done', type: 'completed', color: '#888888' }],
    loading: false
  })
}))

vi.mock('@/store/selectors', async (original) => {
  const empty: [] = []
  return { ...(await original<Record<string, unknown>>()), useAllWorktrees: () => empty }
})

vi.mock('@/store/workspace-record-selectors', async (original) => {
  const empty: [] = []
  return { ...(await original<Record<string, unknown>>()), selectFolderWorkspaces: () => empty }
})

vi.mock('@/components/LinearIssueMarkdownDescriptionEditor', () => ({
  LinearIssueMarkdownDescriptionEditor: () => null
}))

vi.mock('@/components/linear-item-drawer-sheet', () => ({
  renderLinearItemDrawerSheet: (props: {
    displayed: LinearIssue | null
    editState: LinearEditState | null
  }) =>
    props.displayed && props.editState ? (
      <DrawerFields row={props.displayed} editState={props.editState} />
    ) : (
      <div />
    )
}))

export function DrawerFields({ row, editState }: { row: LinearIssue; editState: LinearEditState }) {
  const controller = useLinearIssueEditController({ issue: row, editState })
  return (
    <>
      <output data-testid="drawer">
        {row.state.name}:{editState.priority}:{editState.labels.join(',')}
      </output>
      <button onClick={() => controller.handlePriorityChange('4')}>Priority</button>
      <button onClick={() => controller.handleLabelToggle('bug')}>Label</button>
      <LinearIssueTextEditor issue={row} fields="title" />
    </>
  )
}

export function task(state = 'In Review') {
  return {
    ...issue('same-uuid'),
    identifier: 'DAT-124',
    workspaceId: 'w',
    state: { name: state, type: state === 'Done' ? 'completed' : 'started', color: '#888888' }
  }
}

export function store() {
  const result = createTestStore()
  result.setState({
    linearStatus: { connected: true, viewer: accountViewer, selectedWorkspaceId: 'w' },
    linearStatusObserved: true,
    linearStatusChecked: true,
    linearStatusContextKey: getLinearSourceScope(defaultScopeSource(null)).runtimeContextKey
  })
  active.store.mockReturnValue(result)
  return result
}

export type Store = ReturnType<typeof store>

export type View = 'list' | 'search' | 'project' | 'custom-view'

export const views: View[] = ['list', 'search', 'project', 'custom-view']

export const listArgs = { kind: 'list', filter: 'all', limit: 36 } as const

export function read(s: Store, view: View, force = true) {
  const state = s.getState()
  if (view === 'search') {
    return state.searchLinearIssues('DAT-124', 36, { force })
  }
  if (view === 'project') {
    return state.listLinearProjectIssues('p', 'w', 36, { force })
  }
  if (view === 'custom-view') {
    return state.listLinearCustomViewIssues('v', 'w', 36, { force })
  }
  return state.listLinearIssues(listArgs, { force })
}

export function wire(view: View): Mock {
  return view === 'custom-view' ? reads.view : reads[view]
}

export function response(view: View, state: string) {
  return view === 'search' ? [task(state)] : { items: [task(state)] }
}

export function fixture(s: Store, rows: LinearIssue[], view: View = 'list') {
  return {
    settings: null,
    linearStatus: s.getState().linearStatus,
    selectedLinearWorkspaceId: 'w',
    linearTaskSourceContext: null,
    linearMode: 'issues',
    linearAttributeFilter: { stateIds: [], priorities: [], assignee: null, labelIds: [] },
    linearAttributeFilterWorkspaceId: 'w',
    linearIssues: rows,
    linearIssueLimit: 36,
    linearIssuePage: 0,
    linearIssueLoadingTargetPage: null,
    linearIssuesHasMore: false,
    linearLoading: false,
    linearError: null,
    appliedLinearSearch: view === 'search' ? 'DAT-124' : '',
    selectedLinearProject:
      view === 'project' ? { id: 'p', workspaceId: 'w', name: 'Project' } : null,
    linearProjectTab: view === 'project' ? 'issues' : 'overview',
    linearProjectIssuesResult: { items: rows },
    linearProjectIssueLimit: 36,
    linearProjectIssuePage: 0,
    linearProjectIssueLoadingTargetPage: null,
    linearProjectIssuesLoading: false,
    linearProjectIssuesError: null,
    selectedLinearCustomView:
      view === 'custom-view' ? { id: 'v', workspaceId: 'w', model: 'issue', name: 'View' } : null,
    linearCustomViewIssuesResult: { items: rows },
    linearCustomViewIssueLimit: 36,
    linearCustomViewIssuePage: 0,
    linearCustomViewIssueLoadingTargetPage: null,
    linearCustomViewContentsLoading: false,
    linearCustomViewContentsError: null,
    availableTeams: []
  }
}

export function display(
  s: Store,
  rows: LinearIssue[],
  view: View = 'list',
  context: TaskSourceContext | null = null
) {
  const base = { ...fixture(s, rows, view), ...s.getState() }
  const noop = vi.fn()
  return renderHook(() => {
    const scope = getLinearSourceScope(context ?? defaultScopeSource(null))
    const projectResult = useLinearIssueResult(`${scope.contextKey}project`, { items: rows }, scope)
    const viewResult = useLinearIssueResult(`${scope.contextKey}view`, { items: rows }, scope)
    const result = view === 'custom-view' ? viewResult : projectResult
    const current = view === 'project' || view === 'custom-view' ? result.data.items : rows
    const model = {
      ...base,
      linearTaskSourceContext: context,
      linearIssues: current,
      linearProjectIssueResult: projectResult,
      linearCustomViewIssueResult: viewResult,
      linearProjectIssuesResult: projectResult.data,
      linearCustomViewIssuesResult: viewResult.data,
      taskResumeApplied: true,
      linearProjectSearchInput: '',
      setAppliedLinearProjectSearch: noop,
      filteredLinearIssues: rows,
      clearSelectedLinearIssue: noop,
      linearConnected: true,
      taskSource: 'linear',
      linearRefreshNonce: 0,
      fetchLinearProject: async () => ({ id: 'p' }),
      setSelectedLinearProjectDetail: noop,
      setLinearProjectDetailLoading: noop,
      setLinearProjectDetailError: noop,
      setLinearProjectIssuesLoading: projectResult.setLoading,
      setLinearProjectIssuesError: projectResult.setError,
      setLinearCustomViewContentsLoading: viewResult.setLoading,
      setLinearCustomViewContentsError: viewResult.setError,
      setLinearCustomViewProjectsResult: noop,
      setLinearProjectIssuesResult: projectResult.setData,
      setLinearCustomViewIssuesResult: viewResult.setData
    }
    // SAFETY: fixture supplies the selected collection loader's fields; unrelated persistence is disabled.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    useTaskPageLinearCollectionEffectsPrelude({
      ...model,
      selectedLinearProject: view === 'project' ? base.selectedLinearProject : null
    } as never)
    // SAFETY: fixture supplies the custom-view loader fields and no view inventory is requested.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    useTaskPageLinearCustomViewEffects({ ...model, linearMode: 'issues' } as never)
    // List/search cache notifications are exercised with the real loader in loadingHook.
    // SAFETY: fixture supplies the selection prelude fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
    const selection = useTaskPageLinearListSelectionPrelude(model as never)
    return { ...selection, loading: result.loading, error: result.error }
  })
}

beforeEach(() => {
  deferredIssueSetters.enabled = false
  deferredIssueSetters.updates.length = 0
  vi.resetAllMocks()
  reads.connect.mockResolvedValue({ ok: true, viewer: accountViewer })
  reads.test.mockResolvedValue({ ok: true, viewer: accountViewer })
  clearLinearRequestMaps()
})

afterEach(() => {
  cleanup()
  clearLinearRequestMaps()
})

export function loadingHook(s: Store, query = '', extra = {}, queued?: VoidFunction[]) {
  const refs = {
    linearSearchPersistReadyRef: { current: false },
    linearViewPersistReadyRef: { current: false },
    linearAttributeFilterReadRef: { current: null },
    lastLinearRequestRef: { current: null },
    landingLinearRefreshKeysRef: { current: new Set<string>() }
  }
  const noop = vi.fn()
  let renderCount = 0
  const base = {
    ...fixture(s, [task()]),
    ...refs,
    ...s.getState(),
    taskSource: 'linear',
    linearConnected: true,
    taskResumeApplied: true,
    linearSearchInput: query,
    appliedLinearSearch: query,
    setTaskResumeState: noop,
    setAppliedLinearSearch: noop,
    setLinearIssueLimit: noop,
    setLinearIssuePage: noop,
    setLinearIssueLoadingTargetPage: noop,
    setLinearIssuesHasMore: noop,
    setLinearLoading: noop,
    linearIssueFiltersByWorkspaceId: {},
    ...extra
  }
  return renderHook(
    ({ nonce }) => {
      renderCount++
      const scope = getLinearSourceScope(defaultScopeSource(null))
      const result = useLinearIssueResult(scope.contextKey + query, [task()], scope)
      const { data: rows, error, loading, read: consumeLinearRead } = result
      const deliver = useCallback<typeof consumeLinearRead>(
        (lease, view, value) => {
          if (queued && 'data' in value) {
            queued.push(() => consumeLinearRead(lease, view, value))
            // Preserve the original delayed-row seam: outcome consumption is immediate.
            const { data: _rows, ...outcome } = value
            consumeLinearRead(lease, view, outcome)
          } else {
            consumeLinearRead(lease, view, value)
          }
        },
        [consumeLinearRead]
      )
      // SAFETY: fixture supplies the loader's dependencies; persistence setters are inert in this hook test.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
      useTaskPageLinearListEffects({
        ...base,
        linearRefreshNonce: nonce,
        linearIssueResult: { ...result, read: deliver },
        setLinearIssues: result.setData,
        setLinearError: result.setError,
        setLinearLoading: result.setLoading,
        setLinearIssuesHasMore: result.setHasMore
      } as never)
      // SAFETY: the same fixture supplies the rendered selection fields.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
      const selection = useTaskPageLinearListSelectionPrelude({
        ...base,
        linearIssues: rows,
        linearError: error
      } as never)
      return {
        rows,
        error,
        loading,
        displayed: selection.displayedLinearIssues,

        renders: renderCount
      }
    },
    { initialProps: { nonce: 0 } }
  )
}

export function source(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'linear',
    hostId,
    projectId: 'project',
    repoId: null,
    providerIdentity: null,
    accountLabel: null
  }
}

export { reads }

export function useRoutingFixture(
  context: ReturnType<typeof source> | null,
  initial: LinearIssue | null = null
) {
  const noop = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  return useTaskPageDetailRouting({
    pageData: { openLinearIssue: initial ?? undefined },
    linearTaskSourceContext: context,
    setDialogWorkItem: noop,
    openTaskPage: noop
  } as never)
}
