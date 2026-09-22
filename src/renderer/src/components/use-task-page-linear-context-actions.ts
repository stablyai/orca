import { useCallback } from 'react'
import { toast } from 'sonner'

import { translate } from '@/i18n/i18n'
import type { LinearMode } from '@/components/task-page-localized-options'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../shared/linear/project-types'

import { LINEAR_ITEM_LIMIT } from './task-page-source-context'
import type { TaskPageLinearContextStatePreludeModel } from './use-task-page-linear-context-state'

export function useTaskPageLinearContextActions(model: TaskPageLinearContextStatePreludeModel) {
  const {
    setTaskResumeState,
    clearSelectedLinearIssue,
    setLinearMode,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectTab,
    setLinearProjectIssuesResult,
    setLinearProjectIssueLimit,
    setLinearProjectIssuePage,
    setLinearProjectIssueLoadingTargetPage,
    setLinearCustomViewIssuesResult,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    setLinearCustomViewIssueLimit,
    setLinearCustomViewIssuePage,
    setLinearCustomViewIssueLoadingTargetPage,
    setLinearCustomViewProjectsResult
  } = model
  const patchScopedLinearIssue = useCallback(
    (issueId: string, patch: Partial<LinearIssue>) => {
      const patchResult = (result: LinearCollectionResult<LinearIssue>) => ({
        ...result,
        items: result.items.map((item) =>
          item.id === issueId
            ? {
                ...item,
                ...patch
              }
            : item
        )
      })
      setLinearProjectIssuesResult(patchResult)
      setLinearCustomViewIssuesResult(patchResult)
    },
    [setLinearCustomViewIssuesResult, setLinearProjectIssuesResult]
  )
  const selectLinearMode = useCallback(
    (mode: LinearMode) => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectIssuesResult({
        items: []
      })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setLinearCustomViewProjectsResult({
        items: []
      })
      setLinearMode(mode)
      setTaskResumeState({
        linearMode: mode,
        linearContext: undefined
      })
    },
    [
      clearSelectedLinearIssue,
      setLinearCustomViewIssueLimit,
      setLinearCustomViewIssueLoadingTargetPage,
      setLinearCustomViewIssuePage,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewProjectsResult,
      setLinearMode,
      setLinearProjectIssueLimit,
      setLinearProjectIssueLoadingTargetPage,
      setLinearProjectIssuePage,
      setLinearProjectIssuesResult,
      setLinearProjectParentView,
      setSelectedLinearCustomView,
      setSelectedLinearProject,
      setSelectedLinearProjectDetail,
      setTaskResumeState
    ]
  )
  const openLinearProjectContext = useCallback(
    (
      project: LinearProjectSummary,
      options?: {
        parentView?: LinearCustomViewSummary | null
      }
    ) => {
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
        setLinearCustomViewProjectsResult({
          items: []
        })
      }
      setLinearProjectIssuesResult({
        items: []
      })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setSelectedLinearProject(project)
      setLinearProjectTab('overview')
      setLinearMode('projects')
      setTaskResumeState({
        linearMode: 'projects',
        linearContext: {
          kind: 'project',
          id: project.id,
          workspaceId: project.workspaceId
        }
      })
    },
    [
      clearSelectedLinearIssue,
      setLinearCustomViewIssueLimit,
      setLinearCustomViewIssueLoadingTargetPage,
      setLinearCustomViewIssuePage,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewProjectsResult,
      setLinearMode,
      setLinearProjectIssueLimit,
      setLinearProjectIssueLoadingTargetPage,
      setLinearProjectIssuePage,
      setLinearProjectIssuesResult,
      setLinearProjectParentView,
      setLinearProjectTab,
      setSelectedLinearCustomView,
      setSelectedLinearProject,
      setTaskResumeState
    ]
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
      setLinearProjectIssuesResult({
        items: []
      })
      setLinearProjectIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearProjectIssuePage(0)
      setLinearProjectIssueLoadingTargetPage(null)
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewIssueLimit(LINEAR_ITEM_LIMIT)
      setLinearCustomViewIssuePage(0)
      setLinearCustomViewIssueLoadingTargetPage(null)
      setLinearCustomViewProjectsResult({
        items: []
      })
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
    [
      clearSelectedLinearIssue,
      setLinearCustomViewIssueLimit,
      setLinearCustomViewIssueLoadingTargetPage,
      setLinearCustomViewIssuePage,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewProjectsResult,
      setLinearMode,
      setLinearProjectIssueLimit,
      setLinearProjectIssueLoadingTargetPage,
      setLinearProjectIssuePage,
      setLinearProjectIssuesResult,
      setLinearProjectParentView,
      setSelectedLinearCustomView,
      setSelectedLinearProject,
      setSelectedLinearProjectDetail,
      setTaskResumeState
    ]
  )
  const nextModel = model as typeof model & {
    patchScopedLinearIssue: typeof patchScopedLinearIssue
    selectLinearMode: typeof selectLinearMode
    openLinearProjectContext: typeof openLinearProjectContext
    openLinearCustomViewContext: typeof openLinearCustomViewContext
  }
  nextModel.patchScopedLinearIssue = patchScopedLinearIssue
  nextModel.selectLinearMode = selectLinearMode
  nextModel.openLinearProjectContext = openLinearProjectContext
  nextModel.openLinearCustomViewContext = openLinearCustomViewContext
  return nextModel
}

export type TaskPageLinearContextActionsModel = ReturnType<typeof useTaskPageLinearContextActions>
