import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useAppStore } from '@/store'
import type { TaskPageLinearViewStatePreludeModel } from './use-task-page-linear-view-state'
import { useState, useRef } from 'react'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import { useTaskPageLinearContextActions } from './use-task-page-linear-context-actions'
export function useTaskPageLinearContextStatePrelude(model: TaskPageLinearViewStatePreludeModel) {
  const [linearCustomViewsResult, setLinearCustomViewsResult] = useState<
    LinearCollectionResult<LinearCustomViewSummary>
  >({
    items: []
  })
  const [linearCustomViewsLoading, setLinearCustomViewsLoading] = useState(false)
  const [linearCustomViewsError, setLinearCustomViewsError] = useState<string | null>(null)
  const [selectedLinearCustomView, setSelectedLinearCustomView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearProjectParentView, setLinearProjectParentView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearCustomViewIssueLimit, setLinearCustomViewIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearCustomViewIssuePage, setLinearCustomViewIssuePage] = useState(0)
  const [linearCustomViewIssueLoadingTargetPage, setLinearCustomViewIssueLoadingTargetPage] =
    useState<number | null>(null)
  const [linearCustomViewProjectsResult, setLinearCustomViewProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({
    items: []
  })
  const source = model.linearTaskSourceContext ?? defaultScopeSource(model.settings)
  const scopeKey = useAppStore(() => getLinearSourceScope(source).contextKey)
  const linearCustomViewIssueResult = useLinearIssueResult<LinearCollectionResult<LinearIssue>>(
    JSON.stringify([
      scopeKey,
      selectedLinearCustomView?.id,
      selectedLinearCustomView?.workspaceId,
      selectedLinearCustomView?.model,
      linearCustomViewIssueLimit
    ]),
    { items: [] },
    getLinearSourceScope(source)
  )
  const {
    data: linearCustomViewIssuesResult,
    loading: linearCustomViewContentsLoading,
    error: linearCustomViewContentsError,
    setData: setLinearCustomViewIssuesResult,
    setLoading: setLinearCustomViewContentsLoading,
    setError: setLinearCustomViewContentsError
  } = linearCustomViewIssueResult
  const [linearBoardDraggingIssueId, setLinearBoardDraggingIssueId] = useState<string | null>(null)
  const [linearBoardDragOverKey, setLinearBoardDragOverKey] = useState<string | null>(null)
  const [linearBoardUpdatingIssueIds, setLinearBoardUpdatingIssueIds] = useState<
    ReadonlySet<string>
  >(() => new Set())
  const lastLinearRequestRef = useRef<{
    nonce: number
    signature: string
  } | null>(null)
  const landingLinearRefreshKeysRef = useRef<ReadonlySet<string>>(new Set())
  const linearContextResumeAttemptedRef = useRef(false)
  const nextModel = Object.assign(model, {
    linearCustomViewsResult: linearCustomViewsResult,
    setLinearCustomViewsResult: setLinearCustomViewsResult,
    linearCustomViewsLoading: linearCustomViewsLoading,
    setLinearCustomViewsLoading: setLinearCustomViewsLoading,
    linearCustomViewsError: linearCustomViewsError,
    setLinearCustomViewsError: setLinearCustomViewsError,
    selectedLinearCustomView: selectedLinearCustomView,
    setSelectedLinearCustomView: setSelectedLinearCustomView,
    linearProjectParentView: linearProjectParentView,
    setLinearProjectParentView: setLinearProjectParentView,
    linearCustomViewIssuesResult: linearCustomViewIssuesResult,
    setLinearCustomViewIssuesResult: setLinearCustomViewIssuesResult,
    linearCustomViewIssueLimit: linearCustomViewIssueLimit,
    setLinearCustomViewIssueLimit: setLinearCustomViewIssueLimit,
    linearCustomViewIssuePage: linearCustomViewIssuePage,
    setLinearCustomViewIssuePage: setLinearCustomViewIssuePage,
    linearCustomViewIssueLoadingTargetPage: linearCustomViewIssueLoadingTargetPage,
    setLinearCustomViewIssueLoadingTargetPage: setLinearCustomViewIssueLoadingTargetPage,
    linearCustomViewProjectsResult: linearCustomViewProjectsResult,
    setLinearCustomViewProjectsResult: setLinearCustomViewProjectsResult,
    linearCustomViewContentsLoading: linearCustomViewContentsLoading,
    setLinearCustomViewContentsLoading: setLinearCustomViewContentsLoading,
    linearCustomViewContentsError: linearCustomViewContentsError,
    setLinearCustomViewContentsError: setLinearCustomViewContentsError,
    linearBoardDraggingIssueId: linearBoardDraggingIssueId,
    setLinearBoardDraggingIssueId: setLinearBoardDraggingIssueId,
    linearBoardDragOverKey: linearBoardDragOverKey,
    setLinearBoardDragOverKey: setLinearBoardDragOverKey,
    linearBoardUpdatingIssueIds: linearBoardUpdatingIssueIds,
    setLinearBoardUpdatingIssueIds: setLinearBoardUpdatingIssueIds,
    lastLinearRequestRef: lastLinearRequestRef,
    landingLinearRefreshKeysRef: landingLinearRefreshKeysRef,
    linearContextResumeAttemptedRef: linearContextResumeAttemptedRef,
    linearCustomViewIssueResult: linearCustomViewIssueResult
  })
  return nextModel
}
export type TaskPageLinearContextStatePreludeModel = ReturnType<
  typeof useTaskPageLinearContextStatePrelude
>
export function useTaskPageLinearContextState(model: TaskPageLinearViewStatePreludeModel) {
  const stateModel = useTaskPageLinearContextStatePrelude(model)
  return useTaskPageLinearContextActions(stateModel)
}
export type TaskPageLinearContextStateModel = ReturnType<typeof useTaskPageLinearContextState>
