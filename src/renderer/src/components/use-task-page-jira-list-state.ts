import { useTaskPageJiraQuickFilters } from './use-task-page-jira-quick-filters'
import type { JiraStatusCatalogItem } from './task-page-jira-status-catalog'
import { useTaskPageJiraSavedFilters } from './use-task-page-jira-saved-filters'
import { useTaskPageJiraFavouriteFilters } from './use-task-page-jira-favourite-filters'
import type { JiraFavouriteFilter } from '../../../shared/jira/jira-favourite-filters'
import type { JiraSavedFilter } from '../../../shared/jira/jira-saved-filters'
import type { TaskPageLinearViewStateModel } from './task-page/linear/use-task-page-linear-view-state'
import { useState, useMemo, useEffect, useCallback, type SetStateAction } from 'react'
import type {
  JiraIssue,
  JiraProjectStatusOrder,
  JiraPriority
} from '../../../shared/jira/jira-types'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import type { TaskPageJiraJqlRejection } from '@/components/task-page-jira-search'
import type { JiraPresetId } from '@/components/task-page-localized-options'
import type {
  JiraIssueSortColumn,
  JiraIssueSortDirection,
  JiraPrioritiesBySite
} from './jira-issue-sorter'
import { jiraListPrioritiesForTarget } from '@/runtime/runtime-jira-client'
import { loadJiraLinkedView, saveJiraLinkedView } from './jira-linked-view-storage'
import {
  fallbackJiraSortColumn,
  loadJiraListColumnIds,
  saveJiraListColumnIds,
  visibleJiraListColumns,
  type JiraListColumnId
} from './jira-list-columns'
import {
  ipcOrRuntimeTargetForHostId,
  runtimeTargetEnvironmentId
} from '@/runtime/runtime-client-target'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { useTaskPageJiraProjectScope } from './use-task-page-jira-project-scope'
const EMPTY_JIRA_PRIORITIES: JiraPrioritiesBySite = new Map()

export function useTaskPageJiraListState(model: TaskPageLinearViewStateModel) {
  const {
    jiraConnected,
    selectedJiraSiteId,
    taskSource,
    jiraTaskSourceContext,
    accountBackedTaskSourceHostId
  } = model
  const owner = useMemo(
    () =>
      ipcOrRuntimeTargetForHostId(jiraTaskSourceContext?.hostId ?? accountBackedTaskSourceHostId),
    [accountBackedTaskSourceHostId, jiraTaskSourceContext]
  )
  const jiraProjectScope = useTaskPageJiraProjectScope(
    model.repos,
    model.selectedRepos,
    model.pageData.preselectedRepoId,
    model.accountBackedTaskSourceHostId,
    selectedJiraSiteId
  )
  // Jira tab state
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraError, setJiraError] = useState<TaskPageJiraLoadError | null>(null)
  const [jiraErrorDetailsOpen, setJiraErrorDetailsOpen] = useState(false)
  const [jiraJqlRejection, setJiraJqlRejection] = useState<TaskPageJiraJqlRejection | null>(null)
  const [jiraSearchInput, setRawJiraSearchInput] = useState('')
  const [appliedJiraSearch, setAppliedJiraSearch] = useState('')
  const [jiraHasWorkspace, setJiraLinkedView] = useState(loadJiraLinkedView)
  const setJiraHasWorkspace = useCallback((enabled: boolean) => {
    setJiraLinkedView(enabled)
    saveJiraLinkedView(enabled)
  }, [])
  const favourites = useTaskPageJiraFavouriteFilters(model)
  const { clearJiraFavouriteFilter } = favourites
  const setJiraSearchInput = useCallback(
    (value: SetStateAction<string>) => {
      clearJiraFavouriteFilter()
      setRawJiraSearchInput(value)
    },
    [clearJiraFavouriteFilter]
  )
  const setSavedFilterQuery = useCallback(
    (jql: string) => {
      setJiraSearchInput(jql)
      setAppliedJiraSearch(jql)
    },
    [setJiraSearchInput]
  )
  const savedFilters = useTaskPageJiraSavedFilters(model, setSavedFilterQuery)
  const applyJiraSavedFilter = (filter: JiraSavedFilter) => {
    clearJiraFavouriteFilter()
    return savedFilters.applyJiraSavedFilter(filter)
  }
  const applyJiraFavouriteFilter = (filter: JiraFavouriteFilter) =>
    favourites.applyJiraFavouriteFilter(filter, savedFilters.clearJiraSavedFilterSelection, () => {
      setRawJiraSearchInput('')
      setAppliedJiraSearch('')
      setJiraHasWorkspace(false)
    })
  const quickFilters = useTaskPageJiraQuickFilters(model)
  const [jiraStatusCatalog, setJiraStatusCatalog] = useState<{
    scopeKey: string
    items: JiraStatusCatalogItem[]
  } | null>(null)
  const [activeJiraPreset, setActiveJiraPreset] = useState<JiraPresetId>('assigned')
  const [jiraViewMode, setJiraViewMode] = useState<'list' | 'board'>('list')
  const [jiraCurrentSprint, setJiraCurrentSprint] = useState(false)
  const [jiraRefreshNonce, setJiraRefreshNonce] = useState(0)
  const [jiraProjectStatusOrder, setJiraProjectStatusOrder] = useState<{
    order: JiraProjectStatusOrder
    scopeKey: string
  } | null>(null)
  const [jiraColumnIds, setJiraColumnIds] =
    useState<ReadonlySet<JiraListColumnId>>(loadJiraListColumnIds)
  const jiraColumns = useMemo(() => visibleJiraListColumns(jiraColumnIds), [jiraColumnIds])
  const [jiraOrderBy, setJiraOrderBy] = useState<JiraIssueSortColumn>(() =>
    fallbackJiraSortColumn(jiraColumnIds)
  )
  const [jiraOrderDirection, setJiraOrderDirection] = useState<JiraIssueSortDirection>(() =>
    jiraOrderBy === 'updated' ? 'desc' : 'asc'
  )
  const [prioritySnapshot, setPrioritySnapshot] = useState<{
    scopeKey: string
    priorities: JiraPrioritiesBySite
  } | null>(null)
  const toggleJiraColumn = useCallback(
    (column: JiraListColumnId) => {
      if (column === 'key' || column === 'title') {
        return
      }
      const next = new Set(jiraColumnIds)
      if (next.has(column)) {
        next.delete(column)
      } else {
        next.add(column)
      }
      if (!next.has(jiraOrderBy)) {
        const fallback = fallbackJiraSortColumn(next)
        setJiraOrderBy(fallback)
        setJiraOrderDirection(fallback === 'updated' ? 'desc' : 'asc')
      }
      saveJiraListColumnIds(next)
      setJiraColumnIds(next)
    },
    [jiraColumnIds, jiraOrderBy]
  )
  const jiraPrioritySiteIdsKey = useMemo(() => {
    const siteIds =
      selectedJiraSiteId && selectedJiraSiteId !== 'all'
        ? [selectedJiraSiteId]
        : jiraIssues.flatMap((issue) => (issue.siteId ? [issue.siteId] : []))
    // Why: result refreshes replace the issue array; depend on the represented sites, not identity.
    return JSON.stringify([...new Set(siteIds)].sort())
  }, [jiraIssues, selectedJiraSiteId])
  const priorityScopeKey = JSON.stringify([
    owner ? getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(owner)) : null,
    jiraTaskSourceContext ? getTaskSourceCacheScope(jiraTaskSourceContext) : null,
    jiraPrioritySiteIdsKey
  ])
  const prioritiesEnabled = taskSource === 'jira' && jiraConnected && jiraOrderBy === 'priority'
  const jiraPrioritiesBySite: JiraPrioritiesBySite =
    prioritiesEnabled && owner && prioritySnapshot?.scopeKey === priorityScopeKey
      ? prioritySnapshot.priorities
      : EMPTY_JIRA_PRIORITIES
  useEffect(() => {
    if (!prioritiesEnabled || !owner) {
      return
    }
    let cancelled = false
    const decodedSiteIds: unknown = JSON.parse(jiraPrioritySiteIdsKey)
    const jiraPrioritySiteIds = Array.isArray(decodedSiteIds)
      ? decodedSiteIds.filter((siteId): siteId is string => typeof siteId === 'string')
      : []
    void Promise.all(
      jiraPrioritySiteIds.map(async (siteId) => {
        try {
          return [siteId, await jiraListPrioritiesForTarget(owner, siteId)] as const
        } catch {
          return [siteId, [] as JiraPriority[]] as const
        }
      })
    ).then((prioritiesBySite) => {
      if (!cancelled) {
        setPrioritySnapshot({ scopeKey: priorityScopeKey, priorities: new Map(prioritiesBySite) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [prioritiesEnabled, jiraPrioritySiteIdsKey, priorityScopeKey, owner])
  const handleJiraSort = useCallback(
    (column: JiraIssueSortColumn) => {
      if (jiraOrderBy === column) {
        setJiraOrderDirection((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
      } else {
        setJiraOrderBy(column)
        setJiraOrderDirection(column === 'updated' || column === 'status' ? 'desc' : 'asc')
      }
    },
    [jiraOrderBy]
  )
  return Object.assign(model, {
    jiraHasWorkspace,
    setJiraHasWorkspace,
    ...savedFilters,
    ...favourites,
    applyJiraSavedFilter,
    applyJiraFavouriteFilter,
    ...quickFilters,
    jiraStatusCatalog,
    setJiraStatusCatalog,
    ...jiraProjectScope,
    jiraIssues,
    setJiraIssues,
    jiraLoading,
    setJiraLoading,
    jiraError,
    setJiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraJqlRejection,
    setJiraJqlRejection,
    jiraSearchInput,
    setJiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    activeJiraPreset,
    setActiveJiraPreset,
    jiraViewMode,
    setJiraViewMode,
    jiraCurrentSprint,
    setJiraCurrentSprint,
    jiraRefreshNonce,
    setJiraRefreshNonce,
    jiraProjectStatusOrder,
    setJiraProjectStatusOrder,
    jiraOrderBy,
    setJiraOrderBy,
    jiraOrderDirection,
    setJiraOrderDirection,
    jiraPrioritiesBySite,
    jiraPrioritySiteIdsKey,
    handleJiraSort,
    jiraColumnIds,
    jiraColumns,
    toggleJiraColumn
  })
}
export type TaskPageJiraListStateModel = ReturnType<typeof useTaskPageJiraListState>
