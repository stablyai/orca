import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import { LINEAR_ITEM_LIMIT } from '@/components/task-page/task-page-list-limits'
import type { LinearProjectTab } from '@/components/task-page/linear/linear-issue-grouping'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { AppState } from '@/store/types'

export function useTaskPageLinearProjectViewState({
  clearSelectedLinearIssue,
  setLinearMode,
  setTaskResumeState
}: {
  clearSelectedLinearIssue: () => void
  setLinearMode: Dispatch<SetStateAction<LinearMode>>
  setTaskResumeState: AppState['setTaskResumeState']
}) {
  const [linearProjectSearchInput, setLinearProjectSearchInput] = useState('')
  const [appliedLinearProjectSearch, setAppliedLinearProjectSearch] = useState('')
  const [linearProjectsResult, setLinearProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({ items: [] })
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
  >({ items: [] })
  const [linearProjectIssueLimit, setLinearProjectIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearProjectIssuePage, setLinearProjectIssuePage] = useState(0)
  const [linearProjectIssueLoadingTargetPage, setLinearProjectIssueLoadingTargetPage] = useState<
    number | null
  >(null)
  const [linearProjectIssuesLoading, setLinearProjectIssuesLoading] = useState(false)
  const [linearProjectIssuesError, setLinearProjectIssuesError] = useState<string | null>(null)
  const [linearCustomViewsResult, setLinearCustomViewsResult] = useState<
    LinearCollectionResult<LinearCustomViewSummary>
  >({ items: [] })
  const [linearCustomViewsLoading, setLinearCustomViewsLoading] = useState(false)
  const [linearCustomViewsError, setLinearCustomViewsError] = useState<string | null>(null)
  const [selectedLinearCustomView, setSelectedLinearCustomView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearProjectParentView, setLinearProjectParentView] =
    useState<LinearCustomViewSummary | null>(null)
  const [linearCustomViewIssuesResult, setLinearCustomViewIssuesResult] = useState<
    LinearCollectionResult<LinearIssue>
  >({ items: [] })
  const [linearCustomViewIssueLimit, setLinearCustomViewIssueLimit] = useState(LINEAR_ITEM_LIMIT)
  const [linearCustomViewIssuePage, setLinearCustomViewIssuePage] = useState(0)
  const [linearCustomViewIssueLoadingTargetPage, setLinearCustomViewIssueLoadingTargetPage] =
    useState<number | null>(null)
  const [linearCustomViewProjectsResult, setLinearCustomViewProjectsResult] = useState<
    LinearCollectionResult<LinearProjectSummary>
  >({ items: [] })
  const [linearCustomViewContentsLoading, setLinearCustomViewContentsLoading] = useState(false)
  const [linearCustomViewContentsError, setLinearCustomViewContentsError] = useState<string | null>(
    null
  )

  const openLinearProjectContext = useCallback(
    (project: LinearProjectSummary, options?: { parentView?: LinearCustomViewSummary | null }) => {
      if (!project.workspaceId) {
        toast.error(
          translate(
            'auto.components.TaskPage.cba2a2b7fb',
            'Linear project is missing workspace context.'
          )
        )
        return
      }
      const parentView = options?.parentView ?? null
      clearSelectedLinearIssue()
      setLinearProjectParentView(parentView)
      if (parentView) {
        setSelectedLinearCustomView(parentView)
      } else {
        setSelectedLinearCustomView(null)
        setLinearCustomViewProjectsResult({ items: [] })
      }
      setLinearProjectIssuesResult({ items: [] })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({ items: [] })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setSelectedLinearProject(project)
      setLinearProjectTab('overview')
      setLinearMode('projects')
      setTaskResumeState({
        linearMode: 'projects',
        linearContext: { kind: 'project', id: project.id, workspaceId: project.workspaceId }
      })
    },
    [clearSelectedLinearIssue, setTaskResumeState, setLinearMode]
  )

  const openLinearCustomViewContext = useCallback(
    (view: LinearCustomViewSummary) => {
      if (!view.workspaceId) {
        toast.error(
          translate(
            'auto.components.TaskPage.669e419d65',
            'Linear view is missing workspace context.'
          )
        )
        return
      }
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
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
      setSelectedLinearCustomView(view)
      setLinearMode('views')
      setTaskResumeState({
        linearMode: 'views',
        linearContext: {
          kind: 'view',
          id: view.id,
          workspaceId: view.workspaceId,
          model: view.model
        }
      })
    },
    [clearSelectedLinearIssue, setTaskResumeState, setLinearMode]
  )

  return {
    linearProjectSearchInput,
    setLinearProjectSearchInput,
    appliedLinearProjectSearch,
    setAppliedLinearProjectSearch,
    linearProjectsResult,
    setLinearProjectsResult,
    linearProjectsLoading,
    setLinearProjectsLoading,
    linearProjectsError,
    setLinearProjectsError,
    selectedLinearProject,
    setSelectedLinearProject,
    selectedLinearProjectDetail,
    setSelectedLinearProjectDetail,
    linearProjectDetailLoading,
    setLinearProjectDetailLoading,
    linearProjectDetailError,
    setLinearProjectDetailError,
    linearProjectTab,
    setLinearProjectTab,
    linearProjectIssuesResult,
    setLinearProjectIssuesResult,
    linearProjectIssueLimit,
    setLinearProjectIssueLimit,
    linearProjectIssuePage,
    setLinearProjectIssuePage,
    linearProjectIssueLoadingTargetPage,
    setLinearProjectIssueLoadingTargetPage,
    linearProjectIssuesLoading,
    setLinearProjectIssuesLoading,
    linearProjectIssuesError,
    setLinearProjectIssuesError,
    linearCustomViewsResult,
    setLinearCustomViewsResult,
    linearCustomViewsLoading,
    setLinearCustomViewsLoading,
    linearCustomViewsError,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setSelectedLinearCustomView,
    linearProjectParentView,
    setLinearProjectParentView,
    linearCustomViewIssuesResult,
    setLinearCustomViewIssuesResult,
    linearCustomViewIssueLimit,
    setLinearCustomViewIssueLimit,
    linearCustomViewIssuePage,
    setLinearCustomViewIssuePage,
    linearCustomViewIssueLoadingTargetPage,
    setLinearCustomViewIssueLoadingTargetPage,
    linearCustomViewProjectsResult,
    setLinearCustomViewProjectsResult,
    linearCustomViewContentsLoading,
    setLinearCustomViewContentsLoading,
    linearCustomViewContentsError,
    setLinearCustomViewContentsError,
    openLinearProjectContext,
    openLinearCustomViewContext
  }
}
