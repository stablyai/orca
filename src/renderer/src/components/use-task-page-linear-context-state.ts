import type { TaskPageLinearViewStatePreludeModel } from './use-task-page-linear-view-state'
import { useState, useRef } from 'react'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import { LINEAR_ITEM_LIMIT } from './task-page-source-context'
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
  const [linearCustomViewIssuesResult, setLinearCustomViewIssuesResult] = useState<
    LinearCollectionResult<LinearIssue>
  >({
    items: []
  })
  const [linearCustomViewIssueLimit, setLinearCustomViewIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearCustomViewIssuePage, setLinearCustomViewIssuePage] = useState(0)
  const [linearCustomViewIssueLoadingTargetPage, setLinearCustomViewIssueLoadingTargetPage] =
    useState<number | null>(null)
  const [linearCustomViewProjectsResult, setLinearCustomViewProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({
    items: []
  })
  const [linearCustomViewContentsLoading, setLinearCustomViewContentsLoading] = useState(false)
  const [linearCustomViewContentsError, setLinearCustomViewContentsError] = useState<string | null>(
    null
  )
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
  const nextModel = model as typeof model & {
    linearCustomViewsResult: typeof linearCustomViewsResult
    setLinearCustomViewsResult: typeof setLinearCustomViewsResult
    linearCustomViewsLoading: typeof linearCustomViewsLoading
    setLinearCustomViewsLoading: typeof setLinearCustomViewsLoading
    linearCustomViewsError: typeof linearCustomViewsError
    setLinearCustomViewsError: typeof setLinearCustomViewsError
    selectedLinearCustomView: typeof selectedLinearCustomView
    setSelectedLinearCustomView: typeof setSelectedLinearCustomView
    linearProjectParentView: typeof linearProjectParentView
    setLinearProjectParentView: typeof setLinearProjectParentView
    linearCustomViewIssuesResult: typeof linearCustomViewIssuesResult
    setLinearCustomViewIssuesResult: typeof setLinearCustomViewIssuesResult
    linearCustomViewIssueLimit: typeof linearCustomViewIssueLimit
    setLinearCustomViewIssueLimit: typeof setLinearCustomViewIssueLimit
    linearCustomViewIssuePage: typeof linearCustomViewIssuePage
    setLinearCustomViewIssuePage: typeof setLinearCustomViewIssuePage
    linearCustomViewIssueLoadingTargetPage: typeof linearCustomViewIssueLoadingTargetPage
    setLinearCustomViewIssueLoadingTargetPage: typeof setLinearCustomViewIssueLoadingTargetPage
    linearCustomViewProjectsResult: typeof linearCustomViewProjectsResult
    setLinearCustomViewProjectsResult: typeof setLinearCustomViewProjectsResult
    linearCustomViewContentsLoading: typeof linearCustomViewContentsLoading
    setLinearCustomViewContentsLoading: typeof setLinearCustomViewContentsLoading
    linearCustomViewContentsError: typeof linearCustomViewContentsError
    setLinearCustomViewContentsError: typeof setLinearCustomViewContentsError
    linearBoardDraggingIssueId: typeof linearBoardDraggingIssueId
    setLinearBoardDraggingIssueId: typeof setLinearBoardDraggingIssueId
    linearBoardDragOverKey: typeof linearBoardDragOverKey
    setLinearBoardDragOverKey: typeof setLinearBoardDragOverKey
    linearBoardUpdatingIssueIds: typeof linearBoardUpdatingIssueIds
    setLinearBoardUpdatingIssueIds: typeof setLinearBoardUpdatingIssueIds
    lastLinearRequestRef: typeof lastLinearRequestRef
    landingLinearRefreshKeysRef: typeof landingLinearRefreshKeysRef
    linearContextResumeAttemptedRef: typeof linearContextResumeAttemptedRef
  }
  nextModel.linearCustomViewsResult = linearCustomViewsResult
  nextModel.setLinearCustomViewsResult = setLinearCustomViewsResult
  nextModel.linearCustomViewsLoading = linearCustomViewsLoading
  nextModel.setLinearCustomViewsLoading = setLinearCustomViewsLoading
  nextModel.linearCustomViewsError = linearCustomViewsError
  nextModel.setLinearCustomViewsError = setLinearCustomViewsError
  nextModel.selectedLinearCustomView = selectedLinearCustomView
  nextModel.setSelectedLinearCustomView = setSelectedLinearCustomView
  nextModel.linearProjectParentView = linearProjectParentView
  nextModel.setLinearProjectParentView = setLinearProjectParentView
  nextModel.linearCustomViewIssuesResult = linearCustomViewIssuesResult
  nextModel.setLinearCustomViewIssuesResult = setLinearCustomViewIssuesResult
  nextModel.linearCustomViewIssueLimit = linearCustomViewIssueLimit
  nextModel.setLinearCustomViewIssueLimit = setLinearCustomViewIssueLimit
  nextModel.linearCustomViewIssuePage = linearCustomViewIssuePage
  nextModel.setLinearCustomViewIssuePage = setLinearCustomViewIssuePage
  nextModel.linearCustomViewIssueLoadingTargetPage = linearCustomViewIssueLoadingTargetPage
  nextModel.setLinearCustomViewIssueLoadingTargetPage = setLinearCustomViewIssueLoadingTargetPage
  nextModel.linearCustomViewProjectsResult = linearCustomViewProjectsResult
  nextModel.setLinearCustomViewProjectsResult = setLinearCustomViewProjectsResult
  nextModel.linearCustomViewContentsLoading = linearCustomViewContentsLoading
  nextModel.setLinearCustomViewContentsLoading = setLinearCustomViewContentsLoading
  nextModel.linearCustomViewContentsError = linearCustomViewContentsError
  nextModel.setLinearCustomViewContentsError = setLinearCustomViewContentsError
  nextModel.linearBoardDraggingIssueId = linearBoardDraggingIssueId
  nextModel.setLinearBoardDraggingIssueId = setLinearBoardDraggingIssueId
  nextModel.linearBoardDragOverKey = linearBoardDragOverKey
  nextModel.setLinearBoardDragOverKey = setLinearBoardDragOverKey
  nextModel.linearBoardUpdatingIssueIds = linearBoardUpdatingIssueIds
  nextModel.setLinearBoardUpdatingIssueIds = setLinearBoardUpdatingIssueIds
  nextModel.lastLinearRequestRef = lastLinearRequestRef
  nextModel.landingLinearRefreshKeysRef = landingLinearRefreshKeysRef
  nextModel.linearContextResumeAttemptedRef = linearContextResumeAttemptedRef
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
