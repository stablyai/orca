import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { linearIssueReadError } from '@/lib/linear-read-error'
import { taskProviderErrorText } from '@/lib/task-provider-error-copy'
import type { TaskPageLinearInOrcaEffectsModel } from './use-task-page-linear-in-orca-effects'
import { useEffect } from 'react'
import {
  LINEAR_CUSTOM_VIEW_MODELS,
  mergeLinearCollectionResults
} from './task-page-linear-issue-model'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import type { LinearCollectionResult } from '../../../../../shared/linear/workspace-types'
import type { LinearCustomViewSummary } from '../../../../../shared/linear/project-types'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
export function useTaskPageLinearCustomViewEffects(model: TaskPageLinearInOrcaEffectsModel) {
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
    setSelectedLinearIssue,
    linearSelectionRequest,
    linearMode,
    linearRefreshNonce,
    setLinearCustomViewsResult,
    setLinearCustomViewsLoading,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setLinearCustomViewIssuesResult,
    linearCustomViewIssueResult: { read: consumeLinearRead, setLoading: finishLinearLoading },
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
          setLinearCustomViewsError(taskProviderErrorText(linearIssueReadError(error)))
          setLinearCustomViewsLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
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
    linearTaskSourceContext,
    setLinearCustomViewsError,
    setLinearCustomViewsLoading,
    setLinearCustomViewsResult
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
    let release = () => {}
    if (selectedLinearCustomView.model === 'issue') {
      release = observeLinearIssueRead(
        listLinearCustomViewIssues(
          selectedLinearCustomView.id,
          selectedLinearCustomView.workspaceId,
          issueLimit,
          { force: linearRefreshNonce > 0, sourceContext: linearTaskSourceContext }
        ),
        () => !cancelled,
        (lease, view) => {
          if (view.kind === 'abandoned') {
            if (!cancelled) {
              finishLinearLoading(false)
            }
            return
          }
          consumeLinearRead(lease, view, {
            ...(view.data ? { data: view.data } : {}),
            error:
              view.kind === 'error'
                ? taskProviderErrorText(linearIssueReadError(view.error))
                : view.data?.errors?.length
                  ? taskProviderErrorText(linearIssueReadError(view.data.errors[0].message))
                  : null,
            loading: view.kind === 'loading'
          })
        }
      )
    } else {
      void listLinearCustomViewProjects(
        selectedLinearCustomView.id,
        selectedLinearCustomView.workspaceId,
        LINEAR_ITEM_LIMIT,
        { force: linearRefreshNonce > 0, sourceContext: linearTaskSourceContext }
      )
        .then((result) => {
          if (!cancelled) {
            setLinearCustomViewProjectsResult(result)
            setLinearCustomViewContentsLoading(false)
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setLinearCustomViewContentsError(taskProviderErrorText(linearIssueReadError(error)))
            setLinearCustomViewContentsLoading(false)
          }
        })
    }
    return () => {
      cancelled = true
      release()
    }
  }, [
    consumeLinearRead,
    finishLinearLoading,
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
    if (!taskResumeApplied || taskSource !== 'linear' || !selectedLinearIssueId) {
      return
    }
    // Why: an observed invalid selection can clear only the request it observed.
    if (
      !linearConnected ||
      (!selectedLinearIssueCanFloat &&
        !filteredLinearIssues.some((issue) => issue.id === selectedLinearIssueId))
    ) {
      setSelectedLinearIssue(null, { expectedSelection: linearSelectionRequest })
    }
  }, [
    setSelectedLinearIssue,
    linearSelectionRequest,
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
