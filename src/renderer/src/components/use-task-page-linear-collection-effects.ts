import type { TaskPageLinearInOrcaEffectsModel } from './use-task-page-linear-in-orca-effects'
import { useEffect } from 'react'
import { TASK_SEARCH_DEBOUNCE_MS, LINEAR_ITEM_LIMIT } from './task-page-source-context'
import { clampLinearIssueListLimit } from '../../../shared/linear/issue-read-limits'
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'
export type TaskPageLinearCollectionEffectsPreludeModel = TaskPageLinearInOrcaEffectsModel
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
    linearProjectIssueLimit,
    setLinearProjectIssuesLoading,
    setLinearProjectIssuesError,
    setLinearProjectParentView
  } = model
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    const timeout = window.setTimeout(() => {
      setAppliedLinearProjectSearch(linearProjectSearchInput)
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [linearProjectSearchInput, taskResumeApplied, setAppliedLinearProjectSearch])
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
          setLinearProjectsError(
            error instanceof Error ? error.message : 'Failed to load projects.'
          )
          setLinearProjectsLoading(false)
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
    selectedLinearProject,
    appliedLinearProjectSearch,
    linearRefreshNonce,
    getCachedLinearProjects,
    linearTaskSourceContext
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
            setLinearProjectsError('Project was not found.')
            setTaskResumeState({
              linearContext: undefined
            })
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectDetailError(
            error instanceof Error ? error.message : 'Failed to load project.'
          )
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
    void listLinearProjectIssues(
      selectedLinearProject.id,
      selectedLinearProject.workspaceId,
      effectiveLimit,
      {
        force: linearRefreshNonce > 0,
        sourceContext: linearTaskSourceContext
      }
    )
      .then((result) => {
        if (!cancelled) {
          setLinearProjectIssuesResult(result)
          setLinearProjectIssuesLoading(false)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLinearProjectIssuesError(
            error instanceof Error ? error.message : 'Failed to load project issues.'
          )
          setLinearProjectIssuesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
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
