import { observeLinearIssueRead } from '@/store/slices/linear/linear-issue-publication'
import { linearIssueReadError } from '@/lib/linear-read-error'
import { taskProviderErrorText } from '@/lib/task-provider-error-copy'
import { translate } from '@/i18n/i18n'
import type { TaskPageLinearInOrcaEffectsModel } from './use-task-page-linear-in-orca-effects'
import { useEffect } from 'react'
import { LINEAR_ITEM_LIMIT } from '../task-page-source-context'
import { useTaskSearchDebouncedApply } from '../use-task-search-debounced-apply'
import { clampLinearIssueListLimit } from '../../../../../shared/linear/issue-read-limits'
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'

export function useTaskPageLinearCollectionEffectsPrelude(model: TaskPageLinearInOrcaEffectsModel) {
  const {
    setTaskResumeState,
    getCachedLinearProjects,
    listLinearProjectsFromStore,
    fetchLinearProject,
    listLinearProjectIssues,
    linearConnected,
    selectedLinearWorkspaceId,
    taskSource,
    linearTaskSourceContext,
    taskResumeApplied,
    linearMode,
    linearRefreshNonce,
    linearProjectSearchInput,
    appliedLinearProjectSearch,
    setAppliedLinearProjectSearch,
    setLinearProjectsResult,
    setLinearProjectsLoading,
    setLinearProjectsError,
    selectedLinearProject,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectDetailLoading,
    setLinearProjectDetailError,
    linearProjectTab,
    setLinearProjectIssuesResult,
    linearProjectIssueResult: { read: consumeLinearRead, setLoading: finishLinearLoading },
    linearProjectIssueLimit,
    setLinearProjectIssuesLoading,
    setLinearProjectIssuesError,
    setLinearProjectParentView
  } = model
  useTaskSearchDebouncedApply(
    linearProjectSearchInput,
    taskResumeApplied,
    setAppliedLinearProjectSearch
  )
  useEffect(() => {
    if (!taskResumeApplied || taskSource !== 'linear' || linearMode !== 'projects') {
      return
    }
    if (!linearConnected || selectedLinearProject) {
      return
    }
    let cancelled = false
    const query = appliedLinearProjectSearch.trim()
    const cached = getCachedLinearProjects(query || undefined, LINEAR_ITEM_LIMIT, undefined, {
      sourceContext: linearTaskSourceContext
    })
    if (cached) {
      setLinearProjectsResult(cached)
    }
    const force = linearRefreshNonce > 0
    setLinearProjectsLoading(force || cached === null)
    setLinearProjectsError(null)
    void listLinearProjectsFromStore(query || undefined, LINEAR_ITEM_LIMIT, undefined, {
      force,
      sourceContext: linearTaskSourceContext
    })
      .then((result) => {
        if (!cancelled) {
          setLinearProjectsResult(result)
          setLinearProjectsLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectsError(taskProviderErrorText(linearIssueReadError(error)))
          setLinearProjectsLoading(false)
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
    selectedLinearProject,
    appliedLinearProjectSearch,
    linearRefreshNonce,
    getCachedLinearProjects,
    listLinearProjectsFromStore,
    linearTaskSourceContext,
    setLinearProjectsError,
    setLinearProjectsLoading,
    setLinearProjectsResult
  ])
  useEffect(() => {
    if (!selectedLinearProject?.workspaceId) {
      setSelectedLinearProjectDetail(null)
      return
    }
    let cancelled = false
    setLinearProjectDetailLoading(true)
    setLinearProjectDetailError(null)
    void fetchLinearProject(selectedLinearProject.id, selectedLinearProject.workspaceId, {
      force: linearRefreshNonce > 0,
      sourceContext: linearTaskSourceContext
    })
      .then((project) => {
        if (!cancelled) {
          setSelectedLinearProjectDetail(project)
          setLinearProjectDetailLoading(false)
          if (!project) {
            setSelectedLinearProject(null)
            setLinearProjectParentView(null)
            setLinearProjectDetailError(null)
            setLinearProjectsError(
              translate('taskProviders.linear.projectNotFound', 'Project was not found.')
            )
            setTaskResumeState({
              linearContext: undefined
            })
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectDetailError(taskProviderErrorText(linearIssueReadError(error)))
          setLinearProjectDetailLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    fetchLinearProject,
    linearRefreshNonce,
    selectedLinearProject,
    setTaskResumeState,
    linearTaskSourceContext,
    setSelectedLinearProject,
    setLinearProjectDetailLoading,
    setSelectedLinearProjectDetail,
    setLinearProjectParentView,
    setLinearProjectDetailError,
    setLinearProjectsError
  ])
  useEffect(() => {
    if (!selectedLinearProject?.workspaceId || linearProjectTab !== 'issues') {
      return
    }
    let cancelled = false
    setLinearProjectIssuesLoading(true)
    setLinearProjectIssuesError(null)
    const effectiveLimit = clampLinearIssueListLimit(linearProjectIssueLimit)
    const request = listLinearProjectIssues(
      selectedLinearProject.id,
      selectedLinearProject.workspaceId,
      effectiveLimit,
      {
        force: linearRefreshNonce > 0,
        sourceContext: linearTaskSourceContext
      }
    )
    const release = observeLinearIssueRead(
      request,
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
    return () => {
      cancelled = true
      release()
    }
  }, [
    consumeLinearRead,
    finishLinearLoading,
    linearProjectIssueLimit,
    linearProjectTab,
    linearRefreshNonce,
    listLinearProjectIssues,
    linearTaskSourceContext,
    selectedLinearProject,
    setLinearProjectIssuesError,
    setLinearProjectIssuesResult,
    setLinearProjectIssuesLoading
  ])
  return model
}
export function useTaskPageLinearCollectionEffects(model: TaskPageLinearInOrcaEffectsModel) {
  const preludeModel = useTaskPageLinearCollectionEffectsPrelude(model)
  return useTaskPageLinearCustomViewEffects(preludeModel)
}
export type TaskPageLinearCollectionEffectsModel = ReturnType<
  typeof useTaskPageLinearCollectionEffects
>
