import { useCallback, useEffect, useMemo, useState } from 'react'

import { jiraListPriorities } from '@/runtime/runtime-jira-client'
import type {
  JiraIssueSortColumn,
  JiraIssueSortDirection,
  JiraPrioritiesBySite
} from '@/components/jira-issue-sorter'
import type { JiraPresetId } from '@/components/task-page-localized-options'
import type { TaskPageJiraLoadError } from '@/components/task-page-jira-load-state'
import type {
  JiraIssue,
  JiraPriority,
  JiraProjectStatusOrder
} from '../../../../../shared/jira-types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export function useTaskPageJiraListState({
  selectedJiraSiteId,
  taskSource,
  jiraConnected,
  jiraTaskSourceContext,
  settings
}: {
  selectedJiraSiteId: string | null
  taskSource: TaskProvider
  jiraConnected: boolean
  jiraTaskSourceContext: TaskSourceContext | null
  settings: GlobalSettings | null
}) {
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
  const [jiraOrderBy, setJiraOrderBy] = useState<JiraIssueSortColumn>('updated')
  const [jiraOrderDirection, setJiraOrderDirection] = useState<JiraIssueSortDirection>('desc')
  const [jiraPrioritiesBySite, setJiraPrioritiesBySite] = useState<JiraPrioritiesBySite>(
    () => new Map()
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

  return {
    jiraIssues,
    setJiraIssues,
    jiraLoading,
    setJiraLoading,
    jiraError,
    setJiraError,
    jiraErrorDetailsOpen,
    setJiraErrorDetailsOpen,
    jiraSearchInput,
    setJiraSearchInput,
    appliedJiraSearch,
    setAppliedJiraSearch,
    activeJiraPreset,
    setActiveJiraPreset,
    jiraRefreshNonce,
    setJiraRefreshNonce,
    jiraProjectStatusOrder,
    setJiraProjectStatusOrder,
    jiraOrderBy,
    setJiraOrderBy,
    jiraOrderDirection,
    setJiraOrderDirection,
    jiraPrioritiesBySite,
    setJiraPrioritiesBySite,
    jiraPrioritySiteIdsKey,
    handleJiraSort
  }
}
