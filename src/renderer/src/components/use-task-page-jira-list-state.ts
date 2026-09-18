import type { TaskPageLinearViewStateModel } from './use-task-page-linear-view-state'
import { useState, useMemo, useEffect, useCallback } from 'react'
import type { JiraIssue, JiraProjectStatusOrder, JiraPriority } from '../../../shared/jira-types'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import type { JiraPresetId } from '@/components/task-page-localized-options'
import type {
  JiraIssueSortColumn,
  JiraIssueSortDirection,
  JiraPrioritiesBySite
} from './jira-issue-sorter'
import { jiraListPriorities } from '@/runtime/runtime-jira-client'
import {
  jiraListGridTemplate,
  loadJiraListColumnIds,
  saveJiraListColumnIds,
  visibleJiraListColumns,
  type JiraListColumnId
} from './jira-list-columns'

function fallbackJiraSortColumn(columnIds: ReadonlySet<JiraListColumnId>): JiraIssueSortColumn {
  return columnIds.has('updated') ? 'updated' : 'key'
}

export function useTaskPageJiraListState(model: TaskPageLinearViewStateModel) {
  const { settings, jiraConnected, selectedJiraSiteId, taskSource, jiraTaskSourceContext } = model
  // Jira tab state
  const [jiraIssues, setJiraIssues] = useState<JiraIssue[]>([])
  const [jiraLoading, setJiraLoading] = useState(false)
  const [jiraError, setJiraError] = useState<TaskPageJiraLoadError | null>(null)
  const [jiraErrorDetailsOpen, setJiraErrorDetailsOpen] = useState(false)
  const [jiraSearchInput, setJiraSearchInput] = useState('')
  const [appliedJiraSearch, setAppliedJiraSearch] = useState('')
  const [activeJiraPreset, setActiveJiraPreset] = useState<JiraPresetId>('assigned')
  const [jiraRefreshNonce, setJiraRefreshNonce] = useState(0)
  const [jiraProjectStatusOrder, setJiraProjectStatusOrder] = useState<{
    order: JiraProjectStatusOrder
    scopeKey: string
  } | null>(null)
  const [jiraColumnIds, setJiraColumnIds] =
    useState<ReadonlySet<JiraListColumnId>>(loadJiraListColumnIds)
  // Why: the sort column must stay visible, and a saved selection may hide "updated".
  const [jiraOrderBy, setJiraOrderBy] = useState<JiraIssueSortColumn>(() =>
    fallbackJiraSortColumn(jiraColumnIds)
  )
  const [jiraOrderDirection, setJiraOrderDirection] = useState<JiraIssueSortDirection>('desc')
  const [jiraPrioritiesBySite, setJiraPrioritiesBySite] = useState<JiraPrioritiesBySite>(
    () => new Map()
  )
  const jiraColumns = useMemo(() => visibleJiraListColumns(jiraColumnIds), [jiraColumnIds])
  const jiraGridTemplate = useMemo(() => jiraListGridTemplate(jiraColumns), [jiraColumns])
  const toggleJiraColumn = useCallback(
    (column: JiraListColumnId) => {
      const next = new Set(jiraColumnIds)
      if (next.has(column)) {
        next.delete(column)
        if (jiraOrderBy === column) {
          const fallback = fallbackJiraSortColumn(next)
          setJiraOrderBy(fallback)
          setJiraOrderDirection(fallback === 'updated' ? 'desc' : 'asc')
        }
      } else {
        next.add(column)
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
  useEffect(() => {
    if (taskSource !== 'jira' || !jiraConnected || jiraOrderBy !== 'priority') {
      setJiraPrioritiesBySite((current) => (current.size === 0 ? current : new Map()))
      return
    }
    let cancelled = false
    const jiraPrioritySiteIds = JSON.parse(jiraPrioritySiteIdsKey) as string[]
    void Promise.all(
      jiraPrioritySiteIds.map(async (siteId) => {
        try {
          return [
            siteId,
            await jiraListPriorities(jiraTaskSourceContext ?? settings, siteId)
          ] as const
        } catch {
          return [siteId, [] as JiraPriority[]] as const
        }
      })
    ).then((prioritiesBySite) => {
      if (!cancelled) {
        setJiraPrioritiesBySite(new Map(prioritiesBySite))
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    jiraConnected,
    jiraOrderBy,
    jiraPrioritySiteIdsKey,
    jiraTaskSourceContext,
    settings,
    taskSource
  ])
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model is widened in place with every field assigned right below, matching the other task-page state hooks.
  const nextModel = model as typeof model & {
    jiraIssues: typeof jiraIssues
    setJiraIssues: typeof setJiraIssues
    jiraLoading: typeof jiraLoading
    setJiraLoading: typeof setJiraLoading
    jiraError: typeof jiraError
    setJiraError: typeof setJiraError
    jiraErrorDetailsOpen: typeof jiraErrorDetailsOpen
    setJiraErrorDetailsOpen: typeof setJiraErrorDetailsOpen
    jiraSearchInput: typeof jiraSearchInput
    setJiraSearchInput: typeof setJiraSearchInput
    appliedJiraSearch: typeof appliedJiraSearch
    setAppliedJiraSearch: typeof setAppliedJiraSearch
    activeJiraPreset: typeof activeJiraPreset
    setActiveJiraPreset: typeof setActiveJiraPreset
    jiraRefreshNonce: typeof jiraRefreshNonce
    setJiraRefreshNonce: typeof setJiraRefreshNonce
    jiraProjectStatusOrder: typeof jiraProjectStatusOrder
    setJiraProjectStatusOrder: typeof setJiraProjectStatusOrder
    jiraOrderBy: typeof jiraOrderBy
    setJiraOrderBy: typeof setJiraOrderBy
    jiraOrderDirection: typeof jiraOrderDirection
    setJiraOrderDirection: typeof setJiraOrderDirection
    jiraPrioritiesBySite: typeof jiraPrioritiesBySite
    setJiraPrioritiesBySite: typeof setJiraPrioritiesBySite
    jiraPrioritySiteIdsKey: typeof jiraPrioritySiteIdsKey
    handleJiraSort: typeof handleJiraSort
    jiraColumnIds: typeof jiraColumnIds
    jiraColumns: typeof jiraColumns
    jiraGridTemplate: typeof jiraGridTemplate
    toggleJiraColumn: typeof toggleJiraColumn
  }
  nextModel.jiraIssues = jiraIssues
  nextModel.setJiraIssues = setJiraIssues
  nextModel.jiraLoading = jiraLoading
  nextModel.setJiraLoading = setJiraLoading
  nextModel.jiraError = jiraError
  nextModel.setJiraError = setJiraError
  nextModel.jiraErrorDetailsOpen = jiraErrorDetailsOpen
  nextModel.setJiraErrorDetailsOpen = setJiraErrorDetailsOpen
  nextModel.jiraSearchInput = jiraSearchInput
  nextModel.setJiraSearchInput = setJiraSearchInput
  nextModel.appliedJiraSearch = appliedJiraSearch
  nextModel.setAppliedJiraSearch = setAppliedJiraSearch
  nextModel.activeJiraPreset = activeJiraPreset
  nextModel.setActiveJiraPreset = setActiveJiraPreset
  nextModel.jiraRefreshNonce = jiraRefreshNonce
  nextModel.setJiraRefreshNonce = setJiraRefreshNonce
  nextModel.jiraProjectStatusOrder = jiraProjectStatusOrder
  nextModel.setJiraProjectStatusOrder = setJiraProjectStatusOrder
  nextModel.jiraOrderBy = jiraOrderBy
  nextModel.setJiraOrderBy = setJiraOrderBy
  nextModel.jiraOrderDirection = jiraOrderDirection
  nextModel.setJiraOrderDirection = setJiraOrderDirection
  nextModel.jiraPrioritiesBySite = jiraPrioritiesBySite
  nextModel.setJiraPrioritiesBySite = setJiraPrioritiesBySite
  nextModel.jiraPrioritySiteIdsKey = jiraPrioritySiteIdsKey
  nextModel.handleJiraSort = handleJiraSort
  nextModel.jiraColumnIds = jiraColumnIds
  nextModel.jiraColumns = jiraColumns
  nextModel.jiraGridTemplate = jiraGridTemplate
  nextModel.toggleJiraColumn = toggleJiraColumn
  return nextModel
}
export type TaskPageJiraListStateModel = ReturnType<typeof useTaskPageJiraListState>
