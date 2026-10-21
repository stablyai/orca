// @vitest-environment happy-dom
import { useCallback, useRef, useState } from 'react'
import { create } from 'zustand'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira-types'
import type { JiraSavedFilterState } from '../../../shared/jira-saved-filters'
import type { AppState } from '@/store/types'
import type { TaskPageLinearCollectionEffectsModel } from './use-task-page-linear-collection-effects'
import { createJiraSlice } from '@/store/slices/jira'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import { useTaskPageJiraListEffects } from './use-task-page-jira-list-effects'
import type { JiraStatusCatalogItem } from './task-page-jira-status-catalog'

const runtime = vi.hoisted(() => ({
  capability: vi.fn(),
  rpc: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  statusOrder: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: runtime.capability,
  callRuntimeRpc: runtime.rpc
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListIssuesForTarget: runtime.list,
  jiraSearchIssues: runtime.search,
  jiraGetProjectStatusOrder: runtime.statusOrder
}))

const issue: JiraIssue = {
  id: 'load-failure-1',
  key: 'APP-1',
  siteId: 'site-1',
  title: 'Jira still loads when saved filters are unavailable',
  url: 'https://jira.invalid/browse/APP-1',
  project: { id: 'project-1', key: 'APP', name: 'App' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-10-14',
  updatedAt: '2026-10-14'
}
const issues = [issue]
const selectedStatuses: string[] = []
const noop = () => {}
const suspendedRead = new Promise<JiraIssue[]>(() => {})

function createStore() {
  return create<AppState>()(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Jira collection actions read only the settings, connection status, and caches initialized here.
    (...args) => ({ settings: null, ...createJiraSlice(...args) }) as AppState
  )
}

function useTaskPageFixture(store: ReturnType<typeof createStore>, remote: boolean) {
  const renders = useRef(0)
  renders.current += 1
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraSearchInput, setJiraSearchInput] = useState('')
  const [appliedJiraSearch, setAppliedJiraSearch] = useState('')
  const [jiraRefreshNonce, setJiraRefreshNonce] = useState(0)
  const [, setJiraStatusCatalog] = useState<{
    scopeKey: string
    items: JiraStatusCatalogItem[]
  } | null>(null)
  const setQuery = useCallback((query: string) => {
    setJiraSearchInput(query)
    setAppliedJiraSearch(query)
  }, [])
  const owner = {
    taskSource: 'jira',
    taskResumeApplied: true,
    accountBackedTaskSourceHostId: remote ? 'runtime:unavailable-filter-owner' : 'local',
    jiraTaskSourceContext: null
  } as const
  const savedFilters = useTaskPageJiraSavedFilters(owner, setQuery)
  const model = {
    ...owner,
    ...savedFilters,
    jiraConnected: true,
    selectedJiraSiteId: 'site-1',
    jiraHasWorkspace: false,
    linkedJiraIssueRefs: [],
    linkedJiraIssueRefsSignature: '[]',
    jiraTaskSourceScopeKey: 'load-failure',
    jiraSearchPersistReadyRef: useRef(true),
    selectedJiraIssueKey: null,
    selectedJiraIssueFallback: null,
    setSelectedJiraIssueKey: noop,
    setSelectedJiraIssueFallback: noop,
    setTaskResumeState: noop,
    setJiraError: noop,
    setJiraErrorDetailsOpen: noop,
    setJiraJqlRejection: noop,
    setJiraStatusCatalog,
    setJiraProjectStatusOrder: noop,
    setJiraIssues,
    setJiraLoading,
    jiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    jiraRefreshNonce,
    activeJiraPreset: 'assigned',
    jiraCurrentSprint: false,
    jiraProjectFilter: null,
    selectedJiraStatuses: selectedStatuses,
    jiraQuickFiltersLoading: false,
    displayedJiraIssues: jiraIssues,
    listJiraIssues: store.getState().listJiraIssues,
    searchJiraIssues: store.getState().searchJiraIssues
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All fields read by the real Jira effects are supplied; unrelated provider pipeline stages are omitted.
  useTaskPageJiraListEffects(model as unknown as TaskPageLinearCollectionEffectsModel)
  return {
    ...savedFilters,
    jiraIssues,
    jiraLoading,
    appliedJiraSearch,
    renders: renders.current,
    setJiraSearchInput,
    refresh: () => setJiraRefreshNonce((value) => value + 1)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  runtime.capability.mockResolvedValue(undefined)
  runtime.rpc.mockRejectedValue(new Error('Jira host disconnected'))
  runtime.list.mockResolvedValue(issues)
  runtime.search.mockResolvedValue(issues)
  runtime.statusOrder.mockResolvedValue({ statusIdsByColumn: [], columns: [] })
  vi.stubGlobal('api', { ui: {} })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each([
  { failure: 'plain missing local bridge', remote: false, cache: 'fresh' },
  { failure: 'plain missing local bridge', remote: false, cache: 'stale' },
  { failure: 'rejected remote read', remote: true, cache: 'fresh' },
  { failure: 'rejected remote read', remote: true, cache: 'stale' }
])(
  'settles $cache Jira results after $failure and keeps query/refresh working',
  async (testCase) => {
    const store = createStore()
    store.setState({ jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' } })
    await store.getState().listJiraIssues('assigned', 50)
    if (testCase.cache === 'stale') {
      store.setState((state) => ({
        jiraSearchCache: Object.fromEntries(
          Object.entries(state.jiraSearchCache).map(([key, entry]) => [
            key,
            { ...entry, fetchedAt: Date.now() - 120_000 }
          ])
        )
      }))
    }
    runtime.list.mockClear()
    const originalList = store.getState().listJiraIssues
    const originalSearch = store.getState().searchJiraIssues
    const list = vi.fn<typeof originalList>((...args) =>
      // Stop a regression from hanging the runner while preserving its excess-call evidence.
      list.mock.calls.length > 8 ? suspendedRead : originalList(...args)
    )
    const search = vi.fn<typeof originalSearch>((...args) =>
      search.mock.calls.length > 8 ? suspendedRead : originalSearch(...args)
    )
    store.setState({ listJiraIssues: list, searchJiraIssues: search })

    const { result, rerender } = renderHook(() => useTaskPageFixture(store, testCase.remote))
    await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
    await act(async () => {})
    expect(result.current.jiraSavedFiltersError).toMatch(/Update the Jira host|disconnected/)
    expect(result.current.jiraSavedFiltersReady).toBe(false)
    expect(result.current.jiraLoading).toBe(false)
    expect(result.current.jiraIssues).toEqual(issues)
    expect(list).toHaveBeenCalledTimes(1)
    expect(runtime.list).toHaveBeenCalledTimes(testCase.cache === 'stale' ? 1 : 0)
    expect(result.current.renders).toBeLessThan(12)
    await act(async () => rerender())
    expect(list).toHaveBeenCalledTimes(1)

    act(() => result.current.setJiraSearchInput('login bug'))
    await waitFor(() => expect(result.current.appliedJiraSearch).toBe('login bug'))
    await waitFor(() => expect(result.current.jiraLoading).toBe(false))
    expect(search).toHaveBeenCalledExactlyOnceWith('text ~ "login bug*"', 50, {
      sourceContext: null,
      force: false
    })
    act(() => result.current.refresh())
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.jiraLoading).toBe(false))
    expect(search).toHaveBeenLastCalledWith('text ~ "login bug*"', 50, {
      sourceContext: null,
      force: true
    })
    expect(runtime.search).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
  }
)

it('recovers from a failed owner read and restores the active exact JQL on retry', async () => {
  const store = createStore()
  store.setState({ jiraStatus: { connected: true, viewer: null, selectedSiteId: 'site-1' } })
  const savedState: JiraSavedFilterState = {
    filters: [{ id: 'restored', name: 'Restored', jql: 'filter = 12345' }],
    activeFilterId: 'restored'
  }
  const originalList = store.getState().listJiraIssues
  const list = vi.fn<typeof originalList>((...args) =>
    list.mock.calls.length > 8 ? suspendedRead : originalList(...args)
  )
  const search = vi.fn(store.getState().searchJiraIssues)
  store.setState({ listJiraIssues: list, searchJiraIssues: search })
  const { result } = renderHook(() => useTaskPageFixture(store, true))
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  await act(async () => {})
  expect(list).toHaveBeenCalledTimes(1)

  runtime.rpc.mockResolvedValueOnce(savedState)
  act(() => result.current.retryJiraSavedFilters())
  await waitFor(() => expect(result.current.jiraSavedFiltersReady).toBe(true))
  await waitFor(() => expect(result.current.jiraLoading).toBe(false))
  expect(result.current.jiraSavedFiltersError).toBeNull()
  expect(result.current.appliedJiraSearch).toBe('filter = 12345')
  expect(search).toHaveBeenCalledExactlyOnceWith('filter = 12345', 50, {
    sourceContext: null,
    force: false
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(runtime.rpc).toHaveBeenCalledTimes(2)
})
