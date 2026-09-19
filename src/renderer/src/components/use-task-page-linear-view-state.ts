import type { TaskPageDetailRoutingModel } from './use-task-page-detail-routing'
import { useState, useMemo, useRef } from 'react'
import type {
  LinearMode,
  LinearViewMode,
  LinearGroupBy,
  LinearOrderBy,
  LinearDisplayProperty
} from '@/components/task-page-localized-options'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import type {
  LinearProjectSummary,
  LinearProjectDetail
} from '../../../shared/linear/project-types'
import { LINEAR_ITEM_LIMIT } from './task-page-source-context'
import type { LinearIssueAttributeFilter } from '../../../shared/linear/issue-attribute-filter'
import {
  selectLinearWorkspaceIssueFilter,
  DEFAULT_LINEAR_VIEW_MODE,
  DEFAULT_LINEAR_GROUP_BY,
  DEFAULT_LINEAR_ORDER_BY,
  LINEAR_DISPLAY_PROPERTIES
} from '../../../shared/linear/issue-view-resume-state'
import type {
  LinearIssueListFilterRead,
  LinearPrimaryTeamObservation
} from '@/components/task-page-linear-issue-request'
import type { LinearProjectTab } from './task-page-linear-issue-model'
import { useTaskPageLinearContextState } from './use-task-page-linear-context-state'
export type TaskPageLinearViewStatePreludeModel = ReturnType<
  typeof useTaskPageLinearViewStatePrelude
>
export function useTaskPageLinearViewStatePrelude(model: TaskPageDetailRoutingModel) {
  const { selectedLinearWorkspaceId } = model
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
  const [linearProjectSearchInput, setLinearProjectSearchInput] = useState('')
  const [appliedLinearProjectSearch, setAppliedLinearProjectSearch] = useState('')
  const [linearProjectsResult, setLinearProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({
    items: []
  })
  const [linearProjectsLoading, setLinearProjectsLoading] = useState(false)
  const [linearProjectsError, setLinearProjectsError] = useState<string | null>(null)
  const [selectedLinearProject, setSelectedLinearProject] = useState<LinearProjectSummary | null>(
    null
  )
  const [selectedLinearProjectDetail, setSelectedLinearProjectDetail] =
    useState<LinearProjectDetail | null>(null)
  const [linearProjectDetailLoading, setLinearProjectDetailLoading] = useState(false)
  const [linearProjectDetailError, setLinearProjectDetailError] = useState<string | null>(null)
  const [linearProjectTab, setLinearProjectTab] = useState<LinearProjectTab>('overview')
  const [linearProjectIssuesResult, setLinearProjectIssuesResult] = useState<
    LinearCollectionResult<LinearIssue>
  >({
    items: []
  })
  const [linearProjectIssueLimit, setLinearProjectIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearProjectIssuePage, setLinearProjectIssuePage] = useState(0)
  const [linearProjectIssueLoadingTargetPage, setLinearProjectIssueLoadingTargetPage] = useState<
    number | null
  >(null)
  const [linearProjectIssuesLoading, setLinearProjectIssuesLoading] = useState(false)
  const [linearProjectIssuesError, setLinearProjectIssuesError] = useState<string | null>(null)
  const nextModel = model as typeof model & {
    linearMode: typeof linearMode
    setLinearMode: typeof setLinearMode
    linearIssues: typeof linearIssues
    setLinearIssues: typeof setLinearIssues
    linearIssueLimit: typeof linearIssueLimit
    setLinearIssueLimit: typeof setLinearIssueLimit
    linearIssuePage: typeof linearIssuePage
    setLinearIssuePage: typeof setLinearIssuePage
    linearIssueLoadingTargetPage: typeof linearIssueLoadingTargetPage
    setLinearIssueLoadingTargetPage: typeof setLinearIssueLoadingTargetPage
    linearIssuesHasMore: typeof linearIssuesHasMore
    setLinearIssuesHasMore: typeof setLinearIssuesHasMore
    linearLoading: typeof linearLoading
    setLinearLoading: typeof setLinearLoading
    linearError: typeof linearError
    setLinearError: typeof setLinearError
    linearSearchInput: typeof linearSearchInput
    setLinearSearchInput: typeof setLinearSearchInput
    appliedLinearSearch: typeof appliedLinearSearch
    setAppliedLinearSearch: typeof setAppliedLinearSearch
    linearIssueFiltersByWorkspaceId: typeof linearIssueFiltersByWorkspaceId
    setLinearIssueFiltersByWorkspaceId: typeof setLinearIssueFiltersByWorkspaceId
    linearAttributeFilterWorkspaceId: typeof linearAttributeFilterWorkspaceId
    linearAttributeFilter: typeof linearAttributeFilter
    linearAttributeFilterReadRef: typeof linearAttributeFilterReadRef
    linearPrimaryTeamRef: typeof linearPrimaryTeamRef
    linearViewMode: typeof linearViewMode
    setLinearViewMode: typeof setLinearViewMode
    linearGroupBy: typeof linearGroupBy
    setLinearGroupBy: typeof setLinearGroupBy
    linearOrderBy: typeof linearOrderBy
    setLinearOrderBy: typeof setLinearOrderBy
    linearDisplayProperties: typeof linearDisplayProperties
    setLinearDisplayProperties: typeof setLinearDisplayProperties
    linearTeamPropertyTouched: typeof linearTeamPropertyTouched
    setLinearTeamPropertyTouched: typeof setLinearTeamPropertyTouched
    linearRefreshNonce: typeof linearRefreshNonce
    setLinearRefreshNonce: typeof setLinearRefreshNonce
    linearProjectSearchInput: typeof linearProjectSearchInput
    setLinearProjectSearchInput: typeof setLinearProjectSearchInput
    appliedLinearProjectSearch: typeof appliedLinearProjectSearch
    setAppliedLinearProjectSearch: typeof setAppliedLinearProjectSearch
    linearProjectsResult: typeof linearProjectsResult
    setLinearProjectsResult: typeof setLinearProjectsResult
    linearProjectsLoading: typeof linearProjectsLoading
    setLinearProjectsLoading: typeof setLinearProjectsLoading
    linearProjectsError: typeof linearProjectsError
    setLinearProjectsError: typeof setLinearProjectsError
    selectedLinearProject: typeof selectedLinearProject
    setSelectedLinearProject: typeof setSelectedLinearProject
    selectedLinearProjectDetail: typeof selectedLinearProjectDetail
    setSelectedLinearProjectDetail: typeof setSelectedLinearProjectDetail
    linearProjectDetailLoading: typeof linearProjectDetailLoading
    setLinearProjectDetailLoading: typeof setLinearProjectDetailLoading
    linearProjectDetailError: typeof linearProjectDetailError
    setLinearProjectDetailError: typeof setLinearProjectDetailError
    linearProjectTab: typeof linearProjectTab
    setLinearProjectTab: typeof setLinearProjectTab
    linearProjectIssuesResult: typeof linearProjectIssuesResult
    setLinearProjectIssuesResult: typeof setLinearProjectIssuesResult
    linearProjectIssueLimit: typeof linearProjectIssueLimit
    setLinearProjectIssueLimit: typeof setLinearProjectIssueLimit
    linearProjectIssuePage: typeof linearProjectIssuePage
    setLinearProjectIssuePage: typeof setLinearProjectIssuePage
    linearProjectIssueLoadingTargetPage: typeof linearProjectIssueLoadingTargetPage
    setLinearProjectIssueLoadingTargetPage: typeof setLinearProjectIssueLoadingTargetPage
    linearProjectIssuesLoading: typeof linearProjectIssuesLoading
    setLinearProjectIssuesLoading: typeof setLinearProjectIssuesLoading
    linearProjectIssuesError: typeof linearProjectIssuesError
    setLinearProjectIssuesError: typeof setLinearProjectIssuesError
  }
  nextModel.linearMode = linearMode
  nextModel.setLinearMode = setLinearMode
  nextModel.linearIssues = linearIssues
  nextModel.setLinearIssues = setLinearIssues
  nextModel.linearIssueLimit = linearIssueLimit
  nextModel.setLinearIssueLimit = setLinearIssueLimit
  nextModel.linearIssuePage = linearIssuePage
  nextModel.setLinearIssuePage = setLinearIssuePage
  nextModel.linearIssueLoadingTargetPage = linearIssueLoadingTargetPage
  nextModel.setLinearIssueLoadingTargetPage = setLinearIssueLoadingTargetPage
  nextModel.linearIssuesHasMore = linearIssuesHasMore
  nextModel.setLinearIssuesHasMore = setLinearIssuesHasMore
  nextModel.linearLoading = linearLoading
  nextModel.setLinearLoading = setLinearLoading
  nextModel.linearError = linearError
  nextModel.setLinearError = setLinearError
  nextModel.linearSearchInput = linearSearchInput
  nextModel.setLinearSearchInput = setLinearSearchInput
  nextModel.appliedLinearSearch = appliedLinearSearch
  nextModel.setAppliedLinearSearch = setAppliedLinearSearch
  nextModel.linearIssueFiltersByWorkspaceId = linearIssueFiltersByWorkspaceId
  nextModel.setLinearIssueFiltersByWorkspaceId = setLinearIssueFiltersByWorkspaceId
  nextModel.linearAttributeFilterWorkspaceId = linearAttributeFilterWorkspaceId
  nextModel.linearAttributeFilter = linearAttributeFilter
  nextModel.linearAttributeFilterReadRef = linearAttributeFilterReadRef
  nextModel.linearPrimaryTeamRef = linearPrimaryTeamRef
  nextModel.linearViewMode = linearViewMode
  nextModel.setLinearViewMode = setLinearViewMode
  nextModel.linearGroupBy = linearGroupBy
  nextModel.setLinearGroupBy = setLinearGroupBy
  nextModel.linearOrderBy = linearOrderBy
  nextModel.setLinearOrderBy = setLinearOrderBy
  nextModel.linearDisplayProperties = linearDisplayProperties
  nextModel.setLinearDisplayProperties = setLinearDisplayProperties
  nextModel.linearTeamPropertyTouched = linearTeamPropertyTouched
  nextModel.setLinearTeamPropertyTouched = setLinearTeamPropertyTouched
  nextModel.linearRefreshNonce = linearRefreshNonce
  nextModel.setLinearRefreshNonce = setLinearRefreshNonce
  nextModel.linearProjectSearchInput = linearProjectSearchInput
  nextModel.setLinearProjectSearchInput = setLinearProjectSearchInput
  nextModel.appliedLinearProjectSearch = appliedLinearProjectSearch
  nextModel.setAppliedLinearProjectSearch = setAppliedLinearProjectSearch
  nextModel.linearProjectsResult = linearProjectsResult
  nextModel.setLinearProjectsResult = setLinearProjectsResult
  nextModel.linearProjectsLoading = linearProjectsLoading
  nextModel.setLinearProjectsLoading = setLinearProjectsLoading
  nextModel.linearProjectsError = linearProjectsError
  nextModel.setLinearProjectsError = setLinearProjectsError
  nextModel.selectedLinearProject = selectedLinearProject
  nextModel.setSelectedLinearProject = setSelectedLinearProject
  nextModel.selectedLinearProjectDetail = selectedLinearProjectDetail
  nextModel.setSelectedLinearProjectDetail = setSelectedLinearProjectDetail
  nextModel.linearProjectDetailLoading = linearProjectDetailLoading
  nextModel.setLinearProjectDetailLoading = setLinearProjectDetailLoading
  nextModel.linearProjectDetailError = linearProjectDetailError
  nextModel.setLinearProjectDetailError = setLinearProjectDetailError
  nextModel.linearProjectTab = linearProjectTab
  nextModel.setLinearProjectTab = setLinearProjectTab
  nextModel.linearProjectIssuesResult = linearProjectIssuesResult
  nextModel.setLinearProjectIssuesResult = setLinearProjectIssuesResult
  nextModel.linearProjectIssueLimit = linearProjectIssueLimit
  nextModel.setLinearProjectIssueLimit = setLinearProjectIssueLimit
  nextModel.linearProjectIssuePage = linearProjectIssuePage
  nextModel.setLinearProjectIssuePage = setLinearProjectIssuePage
  nextModel.linearProjectIssueLoadingTargetPage = linearProjectIssueLoadingTargetPage
  nextModel.setLinearProjectIssueLoadingTargetPage = setLinearProjectIssueLoadingTargetPage
  nextModel.linearProjectIssuesLoading = linearProjectIssuesLoading
  nextModel.setLinearProjectIssuesLoading = setLinearProjectIssuesLoading
  nextModel.linearProjectIssuesError = linearProjectIssuesError
  nextModel.setLinearProjectIssuesError = setLinearProjectIssuesError
  return nextModel
}
export function useTaskPageLinearViewState(model: TaskPageDetailRoutingModel) {
  const preludeModel = useTaskPageLinearViewStatePrelude(model)
  return useTaskPageLinearContextState(preludeModel)
}
export type TaskPageLinearViewStateModel = ReturnType<typeof useTaskPageLinearViewState>
