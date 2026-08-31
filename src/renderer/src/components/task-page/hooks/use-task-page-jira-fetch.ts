import { useEffect, type Dispatch, type SetStateAction } from 'react'

import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderScopeKey,
  loadTaskPageJiraProjectStatusOrder
} from '@/components/task-page-jira-status-order'
import {
  createTaskPageJiraLoadFailureState,
  type TaskPageJiraLoadError
} from '@/components/task-page-jira-load-state'
import type { JiraPresetId } from '@/components/task-page-localized-options'
import {
  JIRA_ITEM_LIMIT,
  TASK_SEARCH_DEBOUNCE_MS
} from '@/components/task-page/task-page-list-limits'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../../../shared/jira-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { JiraSlice } from '@/store/slices/jira'
import type { AppState } from '@/store/types'

export function useTaskPageJiraFetch({
  taskResumeApplied,
  jiraSearchInput,
  setAppliedJiraSearch,
  jiraSearchPersistReadyRef,
  appliedJiraSearch,
  setTaskResumeState,
  taskSource,
  jiraConnected,
  setJiraLoading,
  setJiraError,
  setJiraErrorDetailsOpen,
  searchJiraIssues,
  listJiraIssues,
  activeJiraPreset,
  jiraTaskSourceContext,
  selectedJiraSiteId,
  jiraRefreshNonce,
  jiraTaskSourceScopeKey,
  settings,
  setJiraIssues,
  setJiraProjectStatusOrder,
  displayedJiraIssues,
  selectedJiraIssueKey,
  setSelectedJiraIssueKey,
  selectedJiraIssueFallback,
  setSelectedJiraIssueFallback
}: {
  taskResumeApplied: boolean
  jiraSearchInput: string
  setAppliedJiraSearch: Dispatch<SetStateAction<string>>
  jiraSearchPersistReadyRef: { current: boolean }
  appliedJiraSearch: string
  setTaskResumeState: AppState['setTaskResumeState']
  taskSource: TaskProvider
  jiraConnected: boolean
  setJiraLoading: Dispatch<SetStateAction<boolean>>
  setJiraError: Dispatch<SetStateAction<TaskPageJiraLoadError | null>>
  setJiraErrorDetailsOpen: Dispatch<SetStateAction<boolean>>
  searchJiraIssues: JiraSlice['searchJiraIssues']
  listJiraIssues: JiraSlice['listJiraIssues']
  activeJiraPreset: JiraPresetId
  jiraTaskSourceContext: TaskSourceContext | null
  selectedJiraSiteId: string | null
  jiraRefreshNonce: number
  jiraTaskSourceScopeKey: string
  settings: GlobalSettings | null
  setJiraIssues: Dispatch<SetStateAction<JiraIssue[]>>
  setJiraProjectStatusOrder: Dispatch<
    SetStateAction<{
      order: JiraProjectStatusOrder
      scopeKey: string
    } | null>
  >
  displayedJiraIssues: JiraIssue[]
  selectedJiraIssueKey: string | null
  setSelectedJiraIssueKey: Dispatch<SetStateAction<string | null>>
  selectedJiraIssueFallback: JiraIssue | null
  setSelectedJiraIssueFallback: Dispatch<SetStateAction<JiraIssue | null>>
}): void {
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedJiraSearch(jiraSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [jiraSearchInput, taskResumeApplied, setAppliedJiraSearch])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!jiraSearchPersistReadyRef.current) {
      jiraSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ jiraQuery: appliedJiraSearch.trim() })
  }, [appliedJiraSearch, setTaskResumeState, taskResumeApplied, jiraSearchPersistReadyRef])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (taskSource !== 'jira') {
      return
    }
    if (!jiraConnected) {
      return
    }

    let cancelled = false
    setJiraLoading(true)
    setJiraError(null)
    setJiraErrorDetailsOpen(false)

    const trimmed = appliedJiraSearch.trim()
    const request =
      trimmed.length > 0
        ? searchJiraIssues(trimmed, JIRA_ITEM_LIMIT, { sourceContext: jiraTaskSourceContext })
        : listJiraIssues(activeJiraPreset, JIRA_ITEM_LIMIT, {
            sourceContext: jiraTaskSourceContext
          })

    void request
      .then((issues) => {
        if (cancelled) {
          return
        }
        setJiraIssues(issues)
        setJiraLoading(false)
        const projectScope = getSingleJiraProjectScope(issues)
        if (!projectScope) {
          return
        }
        const statusOrderScopeKey = getTaskPageJiraStatusOrderScopeKey(
          jiraTaskSourceScopeKey,
          projectScope
        )
        void loadTaskPageJiraProjectStatusOrder(
          jiraTaskSourceContext ?? settings,
          jiraTaskSourceScopeKey,
          projectScope
        )
          .then((order) => {
            if (!cancelled) {
              setJiraProjectStatusOrder({
                order,
                scopeKey: statusOrderScopeKey
              })
            }
          })
          // Why: status order is decorative; a failure must not surface as an unhandled rejection.
          .catch(() => undefined)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        const failureState = createTaskPageJiraLoadFailureState(err)
        setJiraIssues(failureState.issues)
        setJiraError(failureState.error)
        setJiraLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskSource,
    jiraConnected,
    selectedJiraSiteId,
    appliedJiraSearch,
    activeJiraPreset,
    jiraRefreshNonce,
    taskResumeApplied,
    jiraTaskSourceContext,
    jiraTaskSourceScopeKey
  ])

  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'jira') {
      return
    }
    if (!jiraConnected || displayedJiraIssues.length === 0) {
      if (selectedJiraIssueKey !== null) {
        setSelectedJiraIssueKey(null)
      }
      if (selectedJiraIssueFallback !== null) {
        setSelectedJiraIssueFallback(null)
      }
      return
    }
    if (
      selectedJiraIssueKey &&
      !displayedJiraIssues.some((issue) => issue.key === selectedJiraIssueKey)
    ) {
      setSelectedJiraIssueKey(null)
      setSelectedJiraIssueFallback(null)
    }
  }, [
    displayedJiraIssues,
    jiraConnected,
    selectedJiraIssueFallback,
    selectedJiraIssueKey,
    taskResumeApplied,
    taskSource,

    setSelectedJiraIssueFallback,
    setSelectedJiraIssueKey
  ])
}
