import type { TaskPageLinearCollectionEffectsPreludeModel } from './use-task-page-linear-collection-effects'
import { useEffect } from 'react'
import {
  LINEAR_CUSTOM_VIEW_MODELS,
  mergeLinearCollectionResults
} from './task-page-linear-issue-model'
import { LINEAR_ITEM_LIMIT } from './task-page-source-context'
import type { LinearCollectionResult } from '../../../shared/linear/workspace-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import { clampLinearIssueListLimit } from '../../../shared/linear/issue-read-limits'
export function useTaskPageLinearCustomViewEffects(
  model: TaskPageLinearCollectionEffectsPreludeModel
) {
  const {
    getCachedLinearCustomViews,
    listLinearCustomViews,
    listLinearCustomViewIssues,
    listLinearCustomViewProjects,
    linearConnected,
    selectedLinearWorkspaceId,
    taskSource,
    linearTaskSourceContext,
    taskResumeApplied,
    selectedLinearIssueId,
    selectedLinearIssueCanFloat,
    clearSelectedLinearIssue,
    linearMode,
    linearRefreshNonce,
    setLinearCustomViewsResult,
    setLinearCustomViewsLoading,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setLinearCustomViewIssuesResult,
    linearCustomViewIssueLimit,
    setLinearCustomViewProjectsResult,
    setLinearCustomViewContentsLoading,
    setLinearCustomViewContentsError,
    filteredLinearIssues
  } = model
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'views') {
      return
    }
    if (!linearConnected || selectedLinearCustomView) {
      return
    }
    let cancelled = false
    const cachedResults = LINEAR_CUSTOM_VIEW_MODELS.map((model) =>
      getCachedLinearCustomViews(model, LINEAR_ITEM_LIMIT, undefined, {
        sourceContext: linearTaskSourceContext
      })
    )
    const allCached = cachedResults.every(
      (result): result is LinearCollectionResult<LinearCustomViewSummary> => result !== null
    )
    if (allCached) {
      setLinearCustomViewsResult(mergeLinearCollectionResults(cachedResults))
    }
    const force = linearRefreshNonce > 0
    setLinearCustomViewsLoading(force || !allCached)
    setLinearCustomViewsError(null)
    // Why: the Views tab already has a Model column, so list both models rather than add a redundant Issues/Projects switch.
    void Promise.all(
      LINEAR_CUSTOM_VIEW_MODELS.map((model) =>
        listLinearCustomViews(model, LINEAR_ITEM_LIMIT, undefined, {
          force,
          sourceContext: linearTaskSourceContext
        })
      )
    )
      .then((result) => {
        if (!cancelled) {
          setLinearCustomViewsResult(mergeLinearCollectionResults(result))
          setLinearCustomViewsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewsError(
            error instanceof Error ? error.message : 'Failed to load views.'
          )
          setLinearCustomViewsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskResumeApplied,
    taskSource,
    linearMode,
    linearConnected,
    selectedLinearWorkspaceId,
    selectedLinearCustomView,
    linearRefreshNonce,
    getCachedLinearCustomViews,
    listLinearCustomViews,
    linearTaskSourceContext
  ])
  useEffect(() => {
    if (!selectedLinearCustomView?.workspaceId) {
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewProjectsResult({
        items: []
      })
      return
    }
    let cancelled = false
    setLinearCustomViewContentsLoading(true)
    setLinearCustomViewContentsError(null)
    const issueLimit = clampLinearIssueListLimit(linearCustomViewIssueLimit)
    const request =
      selectedLinearCustomView.model === 'issue'
        ? listLinearCustomViewIssues(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            issueLimit,
            {
              force: linearRefreshNonce > 0,
              sourceContext: linearTaskSourceContext
            }
          )
        : listLinearCustomViewProjects(
            selectedLinearCustomView.id,
            selectedLinearCustomView.workspaceId,
            LINEAR_ITEM_LIMIT,
            {
              force: linearRefreshNonce > 0,
              sourceContext: linearTaskSourceContext
            }
          )
    void request
      .then((result) => {
        if (cancelled) {
          return
        }
        if (selectedLinearCustomView.model === 'issue') {
          setLinearCustomViewIssuesResult(result as LinearCollectionResult<LinearIssue>)
        } else {
          setLinearCustomViewProjectsResult(result as LinearCollectionResult<LinearProjectSummary>)
        }
        setLinearCustomViewContentsLoading(false)
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearCustomViewContentsError(
            error instanceof Error ? error.message : 'Failed to load view contents.'
          )
          setLinearCustomViewContentsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    linearRefreshNonce,
    linearCustomViewIssueLimit,
    listLinearCustomViewIssues,
    listLinearCustomViewProjects,
    linearTaskSourceContext,
    selectedLinearCustomView,
    setLinearCustomViewContentsLoading,
    setLinearCustomViewContentsError,
    setLinearCustomViewProjectsResult,
    setLinearCustomViewIssuesResult
  ])
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear') {
      return
    }
    if (!linearConnected) {
      clearSelectedLinearIssue()
      return
    }
    if (filteredLinearIssues.length === 0) {
      if (!selectedLinearIssueCanFloat) {
        clearSelectedLinearIssue()
      }
      return
    }

    // Why: list-first — keep an open inspector only while its issue stays in the filter, not auto-open row 1; user-directed sub-issue nav stays.
    if (
      selectedLinearIssueId &&
      !selectedLinearIssueCanFloat &&
      !filteredLinearIssues.some((issue) => issue.id === selectedLinearIssueId)
    ) {
      clearSelectedLinearIssue()
    }
  }, [
    clearSelectedLinearIssue,
    filteredLinearIssues,
    linearConnected,
    selectedLinearIssueCanFloat,
    selectedLinearIssueId,
    taskResumeApplied,
    taskSource
  ])
  return model
}
export type TaskPageLinearCustomViewEffectsModel = ReturnType<
  typeof useTaskPageLinearCustomViewEffects
>
