import { useMemo, useRef } from 'react'
import { vi, type Mock } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { JiraSavedFilterState } from '../../../../shared/jira-saved-filters'
import type { TaskPageLinearViewStateModel } from '../use-task-page-linear-view-state'
import type { TaskPageLinearCollectionEffectsModel } from '../use-task-page-linear-collection-effects'
import { useTaskPageJiraListState } from '../use-task-page-jira-list-state'
import { useTaskPageJiraListEffects } from '../use-task-page-jira-list-effects'

const favouriteTransport: {
  catalogue: Mock
  readSaved: Mock
  mutateSaved: Mock
  readQuick: Mock
  list: Mock
  search: Mock
  resume: Mock
} = vi.hoisted(() => ({
  catalogue: vi.fn(),
  readSaved: vi.fn(),
  mutateSaved: vi.fn(),
  readQuick: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  resume: vi.fn()
}))
export { favouriteTransport }
vi.mock('@/runtime/runtime-jira-favourite-filters-client', () => ({
  jiraListFavouriteFiltersForTarget: favouriteTransport.catalogue
}))
vi.mock('@/runtime/runtime-jira-saved-filter-state', () => ({
  readJiraSavedFilterState: favouriteTransport.readSaved,
  mutateJiraSavedFilters: favouriteTransport.mutateSaved
}))
vi.mock('@/runtime/runtime-jira-quick-filter-state', () => ({
  readJiraQuickFilterState: favouriteTransport.readQuick
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListPrioritiesForTarget: vi.fn(),
  jiraGetProjectStatusOrder: vi.fn()
}))

export const favourite = {
  id: 'fav-1',
  name: 'My Jira favourite',
  jql: 'filter = 12345 ORDER BY updated DESC',
  siteId: 'site-a'
}
export const named = { id: 'named', name: 'Custom named filter', jql: 'project = CUSTOM' }
export const emptySaved: JiraSavedFilterState = { filters: [named], activeFilterId: null }
const emptyIssues: JiraIssue[] = []
const noop = () => {}

export function resetFavouriteTransport() {
  vi.resetAllMocks()
  favouriteTransport.catalogue.mockImplementation(async (_target, siteId: string) => ({
    supported: true,
    filters: [{ ...favourite, siteId }],
    truncated: false
  }))
  favouriteTransport.readSaved.mockResolvedValue(emptySaved)
  favouriteTransport.mutateSaved.mockImplementation(async (_target, mutation) => ({
    ...emptySaved,
    activeFilterId: mutation.kind === 'select' ? mutation.id : null
  }))
  favouriteTransport.readQuick.mockResolvedValue({ statuses: [] })
  favouriteTransport.list.mockResolvedValue(emptyIssues)
  favouriteTransport.search.mockResolvedValue(emptyIssues)
}

export type FavouriteFixtureProps = { hostId?: ExecutionHostId; siteId?: string; enabled?: boolean }
export function useFavouriteTaskPage({
  hostId = 'runtime:owner-a',
  siteId = 'site-a',
  enabled = true
}: FavouriteFixtureProps = {}) {
  const sourceContext = useMemo(
    () => ({
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'folder-project',
      hostId,
      providerIdentity: { provider: 'jira' as const, siteId: siteId === 'all' ? null : siteId }
    }),
    [hostId, siteId]
  )
  const model = {
    accountBackedTaskSourceHostId: hostId,
    jiraTaskSourceContext: sourceContext,
    jiraTaskSourceScopeKey: JSON.stringify([hostId, siteId]),
    taskSource: enabled ? 'jira' : 'github',
    taskResumeApplied: true,
    jiraConnected: true,
    selectedJiraSiteId: siteId,
    repos: [],
    selectedRepos: [],
    pageData: {},
    settings: { activeRuntimeEnvironmentId: 'different-focused-server' },
    jiraSearchPersistReadyRef: useRef(true),
    selectedJiraIssueKey: null,
    selectedJiraIssueFallback: null,
    setSelectedJiraIssueKey: noop,
    setSelectedJiraIssueFallback: noop,
    setTaskResumeState: favouriteTransport.resume,
    linkedJiraIssueRefs: [],
    linkedJiraIssueRefsSignature: '[]',
    listJiraIssues: favouriteTransport.list,
    searchJiraIssues: favouriteTransport.search
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The actual Jira hooks only read the supplied fields from the preceding provider pipeline.
  const state = useTaskPageJiraListState(model as unknown as TaskPageLinearViewStateModel)
  const effects = { ...state, displayedJiraIssues: state.jiraIssues }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: All fields read by the actual Jira list effect are supplied; unrelated provider stages are omitted.
  useTaskPageJiraListEffects(effects as unknown as TaskPageLinearCollectionEffectsModel)
  return state
}
