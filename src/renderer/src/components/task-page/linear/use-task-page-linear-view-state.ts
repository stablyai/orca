import { useLinearIssueResult } from '@/hooks/linear-issue-committed-state'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useAppStore } from '@/store'
import type { TaskPageDetailRoutingModel } from '../use-task-page-detail-routing'
import { useState, useMemo, useRef, useEffect } from 'react'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspace-worktree'
import { buildLinearIssueWorkspaceAttachmentIndex } from '@/lib/linear-issue-workspace-attachment'
import {
  collectLinkedLinearIssueRefsFromWorktrees,
  linkedLinearIssueRefsSignature
} from '@/components/task-page/linear/task-page-linear-in-orca-issues'
import type { LinearMode } from '@/components/task-page/task-page-localized-options'
import {
  type LinearViewMode,
  type LinearGroupBy,
  type LinearOrderBy,
  type LinearDisplayProperty,
  selectLinearWorkspaceIssueFilter,
  DEFAULT_LINEAR_VIEW_MODE,
  DEFAULT_LINEAR_GROUP_BY,
  DEFAULT_LINEAR_ORDER_BY,
  LINEAR_DISPLAY_PROPERTIES
} from '../../../../../shared/linear/issue-view-resume-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type {
  LinearProjectSummary,
  LinearProjectDetail
} from '../../../../../shared/linear/project-types'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import type {
  LinearIssueListFilterRead,
  LinearPrimaryTeamObservation
} from '@/components/task-page/linear/task-page-linear-issue-request'
import type { LinearProjectTab } from './task-page-linear-issue-model'
import { useTaskPageLinearContextState } from './use-task-page-linear-context-state'
export type TaskPageLinearViewStatePreludeModel = ReturnType<
  typeof useTaskPageLinearViewStatePrelude
>
export function useTaskPageLinearViewStatePrelude(model: TaskPageDetailRoutingModel) {
  const { selectedLinearWorkspaceId, allWorktrees, folderWorkspaces, linearStatus } = model
  const [linearMode, setLinearMode] = useState<LinearMode>('issues')
  const [linearIssueLimit, setLinearIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearIssuePage, setLinearIssuePage] = useState(0)
  const [linearIssueLoadingTargetPage, setLinearIssueLoadingTargetPage] = useState<number | null>(
    null
  )
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
  // Why: one pass over worktrees per list render; per-row scans re-parsed every link.
  const linearAttachmentWorkspaces = useMemo(
    () => [...allWorktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)],
    [allWorktrees, folderWorkspaces]
  )
  const linearIssueAttachmentIndex = useMemo(
    () => buildLinearIssueWorkspaceAttachmentIndex(linearAttachmentWorkspaces),
    [linearAttachmentWorkspaces]
  )
  const inOrcaLinkedLinearRefs = useMemo(
    () =>
      collectLinkedLinearIssueRefsFromWorktrees(linearAttachmentWorkspaces, {
        workspaceId: selectedLinearWorkspaceId,
        workspaces: linearStatus.workspaces ?? []
      }),
    [linearAttachmentWorkspaces, linearStatus.workspaces, selectedLinearWorkspaceId]
  )
  const inOrcaLinkedLinearRefsSignature = useMemo(
    () => linkedLinearIssueRefsSignature(inOrcaLinkedLinearRefs),
    [inOrcaLinkedLinearRefs]
  )
  const inOrcaLinkedLinearRefsRef = useRef(inOrcaLinkedLinearRefs)
  // Keep latest linked refs for the in-orca loader without re-running it on identity churn.
  useEffect(() => {
    inOrcaLinkedLinearRefsRef.current = inOrcaLinkedLinearRefs
  }, [inOrcaLinkedLinearRefs])

  const source = model.linearTaskSourceContext ?? defaultScopeSource(model.settings)
  const scopeKey = useAppStore(() => getLinearSourceScope(source).contextKey)
  const scope = getLinearSourceScope(source)
  const linearIssueResult = useLinearIssueResult<LinearIssue[]>(
    JSON.stringify([
      scopeKey,
      selectedLinearWorkspaceId,
      linearMode,
      appliedLinearSearch,
      linearIssueLimit,
      linearAttributeFilter,
      linearMode === 'in-orca' ? inOrcaLinkedLinearRefsSignature : null
    ]),
    [],
    scope
  )
  const {
    data: linearIssues,
    loading: linearLoading,
    error: linearError,
    hasMore: linearIssuesHasMore,
    setData: setLinearIssues,
    setLoading: setLinearLoading,
    setError: setLinearError,
    setHasMore: setLinearIssuesHasMore
  } = linearIssueResult
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
  const [linearProjectIssueLimit, setLinearProjectIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearProjectIssuePage, setLinearProjectIssuePage] = useState(0)
  const [linearProjectIssueLoadingTargetPage, setLinearProjectIssueLoadingTargetPage] = useState<
    number | null
  >(null)
  const linearProjectIssueResult = useLinearIssueResult<LinearCollectionResult<LinearIssue>>(
    JSON.stringify([
      scopeKey,
      selectedLinearProject?.id,
      selectedLinearProject?.workspaceId,
      linearProjectTab,
      linearProjectIssueLimit
    ]),
    { items: [] },
    scope
  )
  const {
    data: linearProjectIssuesResult,
    loading: linearProjectIssuesLoading,
    error: linearProjectIssuesError,
    setData: setLinearProjectIssuesResult,
    setLoading: setLinearProjectIssuesLoading,
    setError: setLinearProjectIssuesError
  } = linearProjectIssueResult
  const nextModel = Object.assign(model, {
    linearAttachmentWorkspaces,
    linearIssueAttachmentIndex,
    inOrcaLinkedLinearRefs,
    inOrcaLinkedLinearRefsSignature,
    inOrcaLinkedLinearRefsRef,

    linearMode: linearMode,
    setLinearMode: setLinearMode,
    linearIssues: linearIssues,
    setLinearIssues: setLinearIssues,
    linearIssueLimit: linearIssueLimit,
    setLinearIssueLimit: setLinearIssueLimit,
    linearIssuePage: linearIssuePage,
    setLinearIssuePage: setLinearIssuePage,
    linearIssueLoadingTargetPage: linearIssueLoadingTargetPage,
    setLinearIssueLoadingTargetPage: setLinearIssueLoadingTargetPage,
    linearIssuesHasMore: linearIssuesHasMore,
    setLinearIssuesHasMore: setLinearIssuesHasMore,
    linearLoading: linearLoading,
    setLinearLoading: setLinearLoading,
    linearError: linearError,
    setLinearError: setLinearError,
    linearSearchInput: linearSearchInput,
    setLinearSearchInput: setLinearSearchInput,
    appliedLinearSearch: appliedLinearSearch,
    setAppliedLinearSearch: setAppliedLinearSearch,
    linearIssueFiltersByWorkspaceId: linearIssueFiltersByWorkspaceId,
    setLinearIssueFiltersByWorkspaceId: setLinearIssueFiltersByWorkspaceId,
    linearAttributeFilterWorkspaceId: linearAttributeFilterWorkspaceId,
    linearAttributeFilter: linearAttributeFilter,
    linearAttributeFilterReadRef: linearAttributeFilterReadRef,
    linearPrimaryTeamRef: linearPrimaryTeamRef,
    linearViewMode: linearViewMode,
    setLinearViewMode: setLinearViewMode,
    linearGroupBy: linearGroupBy,
    setLinearGroupBy: setLinearGroupBy,
    linearOrderBy: linearOrderBy,
    setLinearOrderBy: setLinearOrderBy,
    linearDisplayProperties: linearDisplayProperties,
    setLinearDisplayProperties: setLinearDisplayProperties,
    linearTeamPropertyTouched: linearTeamPropertyTouched,
    setLinearTeamPropertyTouched: setLinearTeamPropertyTouched,
    linearRefreshNonce: linearRefreshNonce,
    setLinearRefreshNonce: setLinearRefreshNonce,
    linearProjectSearchInput: linearProjectSearchInput,
    setLinearProjectSearchInput: setLinearProjectSearchInput,
    appliedLinearProjectSearch: appliedLinearProjectSearch,
    setAppliedLinearProjectSearch: setAppliedLinearProjectSearch,
    linearProjectsResult: linearProjectsResult,
    setLinearProjectsResult: setLinearProjectsResult,
    linearProjectsLoading: linearProjectsLoading,
    setLinearProjectsLoading: setLinearProjectsLoading,
    linearProjectsError: linearProjectsError,
    setLinearProjectsError: setLinearProjectsError,
    selectedLinearProject: selectedLinearProject,
    setSelectedLinearProject: setSelectedLinearProject,
    selectedLinearProjectDetail: selectedLinearProjectDetail,
    setSelectedLinearProjectDetail: setSelectedLinearProjectDetail,
    linearProjectDetailLoading: linearProjectDetailLoading,
    setLinearProjectDetailLoading: setLinearProjectDetailLoading,
    linearProjectDetailError: linearProjectDetailError,
    setLinearProjectDetailError: setLinearProjectDetailError,
    linearProjectTab: linearProjectTab,
    setLinearProjectTab: setLinearProjectTab,
    linearProjectIssuesResult: linearProjectIssuesResult,
    setLinearProjectIssuesResult: setLinearProjectIssuesResult,
    linearProjectIssueLimit: linearProjectIssueLimit,
    setLinearProjectIssueLimit: setLinearProjectIssueLimit,
    linearProjectIssuePage: linearProjectIssuePage,
    setLinearProjectIssuePage: setLinearProjectIssuePage,
    linearProjectIssueLoadingTargetPage: linearProjectIssueLoadingTargetPage,
    setLinearProjectIssueLoadingTargetPage: setLinearProjectIssueLoadingTargetPage,
    linearProjectIssuesLoading: linearProjectIssuesLoading,
    setLinearProjectIssuesLoading: setLinearProjectIssuesLoading,
    linearProjectIssuesError: linearProjectIssuesError,
    setLinearProjectIssuesError: setLinearProjectIssuesError,
    linearIssueResult: linearIssueResult,
    linearProjectIssueResult: linearProjectIssueResult
  })
  return nextModel
}
export function useTaskPageLinearViewState(model: TaskPageDetailRoutingModel) {
  const preludeModel = useTaskPageLinearViewStatePrelude(model)
  return useTaskPageLinearContextState(preludeModel)
}
export type TaskPageLinearViewStateModel = ReturnType<typeof useTaskPageLinearViewState>
