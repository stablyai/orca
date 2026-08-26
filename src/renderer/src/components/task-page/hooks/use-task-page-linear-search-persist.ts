import { useEffect, type Dispatch, type SetStateAction } from 'react'

import { serializeLinearIssueViewResumeState } from '../../../../../shared/linear/issue-view-resume-state'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import { saveLinearIssueView } from '@/components/linear-issue-view-storage'
import {
  TASK_SEARCH_DEBOUNCE_MS,
  LINEAR_ITEM_LIMIT
} from '@/components/task-page/task-page-list-limits'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearMode,
  LinearOrderBy,
  LinearViewMode
} from '@/components/task-page-localized-options'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { AppState } from '@/store/types'

export function useTaskPageLinearSearchPersist({
  taskResumeApplied,
  linearSearchInput,
  appliedLinearSearch,
  setAppliedLinearSearch,
  setTaskResumeState,
  linearSearchPersistReadyRef,
  linearViewPersistReadyRef,
  linearViewMode,
  linearGroupBy,
  linearOrderBy,
  linearDisplayProperties,
  linearTeamPropertyTouched,
  linearIssueFiltersByWorkspaceId,
  setLinearIssueLimit,
  setLinearIssuePage,
  setLinearIssueLoadingTargetPage,
  linearMode,
  selectedLinearCustomView,
  selectedLinearProject,
  selectedLinearWorkspaceId,
  taskSource
}: {
  taskResumeApplied: boolean
  linearSearchInput: string
  appliedLinearSearch: string
  setAppliedLinearSearch: Dispatch<SetStateAction<string>>
  setTaskResumeState: AppState['setTaskResumeState']
  linearSearchPersistReadyRef: { current: boolean }
  linearViewPersistReadyRef: { current: boolean }
  linearViewMode: LinearViewMode
  linearGroupBy: LinearGroupBy
  linearOrderBy: LinearOrderBy
  linearDisplayProperties: ReadonlySet<LinearDisplayProperty>
  linearTeamPropertyTouched: boolean
  linearIssueFiltersByWorkspaceId: Record<string, LinearIssueAttributeFilter>
  setLinearIssueLimit: Dispatch<SetStateAction<number>>
  setLinearIssuePage: Dispatch<SetStateAction<number>>
  setLinearIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  linearMode: LinearMode
  selectedLinearCustomView: LinearCustomViewSummary | null
  selectedLinearProject: LinearProjectSummary | null
  selectedLinearWorkspaceId: string | null
  taskSource: TaskProvider
}): void {
  // Why: debounce the Linear search input so we don't fire a request per keystroke (300ms, matching GitHub search).
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearSearch(linearSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearSearchInput, taskResumeApplied, setAppliedLinearSearch])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearSearchPersistReadyRef.current) {
      linearSearchPersistReadyRef.current = true
      return
    }
    setTaskResumeState({ linearQuery: appliedLinearSearch.trim() })
  }, [appliedLinearSearch, setTaskResumeState, taskResumeApplied, linearSearchPersistReadyRef])

  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!linearViewPersistReadyRef.current) {
      linearViewPersistReadyRef.current = true
      return
    }
    saveLinearIssueView(
      serializeLinearIssueViewResumeState({
        viewMode: linearViewMode,
        groupBy: linearGroupBy,
        orderBy: linearOrderBy,
        displayProperties: linearDisplayProperties,
        teamPropertyTouched: linearTeamPropertyTouched,
        filtersByWorkspaceId: linearIssueFiltersByWorkspaceId
      })
    )
  }, [
    linearDisplayProperties,
    linearGroupBy,
    linearIssueFiltersByWorkspaceId,
    linearOrderBy,
    linearTeamPropertyTouched,
    linearViewMode,
    taskResumeApplied,

    linearViewPersistReadyRef
  ])

  useEffect(() => {
    setLinearIssueLimit(LINEAR_ITEM_LIMIT)
    setLinearIssuePage(0)
    setLinearIssueLoadingTargetPage(null)
  }, [
    appliedLinearSearch,
    linearMode,
    selectedLinearCustomView?.id,
    selectedLinearProject?.id,
    selectedLinearWorkspaceId,
    taskSource,

    setLinearIssueLimit,
    setLinearIssueLoadingTargetPage,
    setLinearIssuePage
  ])
}
