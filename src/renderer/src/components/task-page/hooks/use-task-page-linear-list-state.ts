import { useCallback, useMemo, useRef, useState } from 'react'

import type {
  LinearIssueListFilterRead,
  LinearPrimaryTeamObservation
} from '@/components/task-page-linear-issue-request'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearMode,
  LinearOrderBy,
  LinearViewMode
} from '@/components/task-page-localized-options'
import { LINEAR_ITEM_LIMIT } from '@/components/task-page/task-page-list-limits'
import { useTaskPageLinearProjectViewState } from '@/components/task-page/hooks/use-task-page-linear-project-view-state'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import {
  DEFAULT_LINEAR_GROUP_BY,
  DEFAULT_LINEAR_ORDER_BY,
  DEFAULT_LINEAR_VIEW_MODE,
  LINEAR_DISPLAY_PROPERTIES,
  selectLinearWorkspaceIssueFilter
} from '../../../../../shared/linear/issue-view-resume-state'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { AppState } from '@/store/types'

export function useTaskPageLinearListState({
  selectedLinearWorkspaceId,
  clearSelectedLinearIssue,
  setTaskResumeState
}: {
  selectedLinearWorkspaceId: string | null
  clearSelectedLinearIssue: () => void
  setTaskResumeState: AppState['setTaskResumeState']
}) {
  // Linear tab state
  const [linearMode, setLinearMode] = useState<LinearMode>('issues')
  const [linearIssues, setLinearIssues] = useState<LinearIssue[]>([])
  const [linearIssueLimit, setLinearIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearIssuePage, setLinearIssuePage] = useState(0)
  const [linearIssueLoadingTargetPage, setLinearIssueLoadingTargetPage] = useState<number | null>(
    null
  )
  const [linearIssuesHasMore, setLinearIssuesHasMore] = useState(false)
  const [linearLoading, setLinearLoading] = useState(false)
  const [linearError, setLinearError] = useState<string | null>(null)
  const [linearSearchInput, setLinearSearchInput] = useState('')
  const [appliedLinearSearch, setAppliedLinearSearch] = useState('')
  const [linearIssueFiltersByWorkspaceId, setLinearIssueFiltersByWorkspaceId] = useState<
    Record<string, LinearIssueAttributeFilter>
  >(() => ({}))
  const linearAttributeFilterWorkspaceId =
    selectedLinearWorkspaceId && selectedLinearWorkspaceId !== 'all'
      ? selectedLinearWorkspaceId
      : null
  const linearAttributeFilter = useMemo(
    () =>
      selectLinearWorkspaceIssueFilter(
        linearIssueFiltersByWorkspaceId,
        linearAttributeFilterWorkspaceId
      ),
    [linearAttributeFilterWorkspaceId, linearIssueFiltersByWorkspaceId]
  )
  const linearAttributeFilterReadRef = useRef<LinearIssueListFilterRead | null>(null)
  const linearPrimaryTeamRef = useRef<LinearPrimaryTeamObservation | null>(null)
  const [linearViewMode, setLinearViewMode] = useState<LinearViewMode>(DEFAULT_LINEAR_VIEW_MODE)
  const [linearGroupBy, setLinearGroupBy] = useState<LinearGroupBy>(DEFAULT_LINEAR_GROUP_BY)
  const [linearOrderBy, setLinearOrderBy] = useState<LinearOrderBy>(DEFAULT_LINEAR_ORDER_BY)
  const [linearDisplayProperties, setLinearDisplayProperties] = useState<
    ReadonlySet<LinearDisplayProperty>
  >(() => new Set(LINEAR_DISPLAY_PROPERTIES))
  const [linearTeamPropertyTouched, setLinearTeamPropertyTouched] = useState(false)
  const [linearRefreshNonce, setLinearRefreshNonce] = useState(0)
  const projectViewState = useTaskPageLinearProjectViewState({
    clearSelectedLinearIssue,
    setLinearMode,
    setTaskResumeState
  })
  const {
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    setLinearProjectIssuesResult,
    setLinearProjectIssueLimit,
    setLinearProjectIssuePage,
    setLinearProjectIssueLoadingTargetPage,
    setLinearCustomViewIssuesResult,
    setLinearCustomViewIssueLimit,
    setLinearCustomViewIssuePage,
    setLinearCustomViewIssueLoadingTargetPage,
    setLinearCustomViewProjectsResult
  } = projectViewState
  const [linearBoardDraggingIssueId, setLinearBoardDraggingIssueId] = useState<string | null>(null)
  const [linearBoardDragOverKey, setLinearBoardDragOverKey] = useState<string | null>(null)
  const [linearBoardUpdatingIssueIds, setLinearBoardUpdatingIssueIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const lastLinearRequestRef = useRef<{ nonce: number; signature: string } | null>(null)
  const landingLinearRefreshKeysRef = useRef<ReadonlySet<string>>(new Set())
  const linearContextResumeAttemptedRef = useRef(false)

  const patchScopedLinearIssue = useCallback(
    (issueId: string, patch: Partial<LinearIssue>) => {
      const patchResult = (result: LinearCollectionResult<LinearIssue>) => ({
        ...result,
        items: result.items.map((item) => (item.id === issueId ? { ...item, ...patch } : item))
      })
      setLinearProjectIssuesResult(patchResult)
      setLinearCustomViewIssuesResult(patchResult)
    },
    [setLinearProjectIssuesResult, setLinearCustomViewIssuesResult]
  )

  const selectLinearMode = useCallback(
    (mode: LinearMode) => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectIssuesResult({ items: [] })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setLinearCustomViewProjectsResult({ items: [] })
      setLinearMode(mode)
      setTaskResumeState({ linearMode: mode, linearContext: undefined })
    },
    [
      clearSelectedLinearIssue,
      setTaskResumeState,
      setLinearProjectIssuesResult,
      setSelectedLinearCustomView,
      setLinearProjectParentView,
      setLinearProjectIssueLimit,
      setSelectedLinearProject,
      setLinearCustomViewIssueLimit,
      setLinearCustomViewProjectsResult,
      setSelectedLinearProjectDetail,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewIssuePage,
      setLinearCustomViewIssueLoadingTargetPage,
      setLinearProjectIssueLoadingTargetPage,
      setLinearProjectIssuePage
    ]
  )

  return {
    linearMode,
    setLinearMode,
    linearIssues,
    setLinearIssues,
    linearIssueLimit,
    setLinearIssueLimit,
    linearIssuePage,
    setLinearIssuePage,
    linearIssueLoadingTargetPage,
    setLinearIssueLoadingTargetPage,
    linearIssuesHasMore,
    setLinearIssuesHasMore,
    linearLoading,
    setLinearLoading,
    linearError,
    setLinearError,
    linearSearchInput,
    setLinearSearchInput,
    appliedLinearSearch,
    setAppliedLinearSearch,
    linearIssueFiltersByWorkspaceId,
    setLinearIssueFiltersByWorkspaceId,
    linearAttributeFilterWorkspaceId,
    linearAttributeFilter,
    linearAttributeFilterReadRef,
    linearPrimaryTeamRef,
    linearViewMode,
    setLinearViewMode,
    linearGroupBy,
    setLinearGroupBy,
    linearOrderBy,
    setLinearOrderBy,
    linearDisplayProperties,
    setLinearDisplayProperties,
    linearTeamPropertyTouched,
    setLinearTeamPropertyTouched,
    linearRefreshNonce,
    setLinearRefreshNonce,
    ...projectViewState,
    linearBoardDraggingIssueId,
    setLinearBoardDraggingIssueId,
    linearBoardDragOverKey,
    setLinearBoardDragOverKey,
    linearBoardUpdatingIssueIds,
    setLinearBoardUpdatingIssueIds,
    lastLinearRequestRef,
    landingLinearRefreshKeysRef,
    linearContextResumeAttemptedRef,
    patchScopedLinearIssue,
    selectLinearMode
  }
}
