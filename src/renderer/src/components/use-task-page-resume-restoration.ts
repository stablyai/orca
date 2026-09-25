import type { TaskPageJiraListStateModel } from './use-task-page-jira-list-state'
import { useEffect } from 'react'
import { resolveVisibleTaskProvider } from '../../../shared/task-providers'
import { normalizeGitHubTaskPreset } from '@/components/task-page-github-task-kind'
import { getTaskPresetQuery } from '../../../shared/task-preset-query'
import { loadLinearIssueView } from './linear-issue-view-storage'
export function useTaskPageResumeRestoration(model: TaskPageJiraListStateModel) {
  const {
    settings,
    persistedUIReady,
    taskResumeState,
    setTaskResumeState,
    pageData,
    fetchLinearProject,
    listLinearCustomViews,
    fetchLinearCustomView,
    linearConnected,
    resolvedInitialSelection,
    setRepoSelection,
    visibleTaskProviders,
    taskSource,
    setTaskSource,
    linearTaskSourceContext,
    taskResumeAppliedRef,
    taskResumeApplied,
    setTaskResumeApplied,
    setGithubMode,
    setTaskSearchInput,
    setAppliedTaskSearch,
    setActiveTaskPreset,
    setLinearMode,
    setLinearSearchInput,
    setAppliedLinearSearch,
    setLinearIssueFiltersByWorkspaceId,
    setLinearViewMode,
    setLinearGroupBy,
    setLinearOrderBy,
    setLinearDisplayProperties,
    setLinearTeamPropertyTouched,
    setLinearProjectsError,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearCustomViewsLoading,
    setLinearCustomViewsError,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    linearContextResumeAttemptedRef,
    setJiraSearchInput,
    setAppliedJiraSearch,
    setActiveJiraPreset
  } = model
  useEffect(() => {
    if (taskResumeAppliedRef.current || !persistedUIReady || !settings) {
      return
    }
    setTaskSource(
      resolveVisibleTaskProvider(
        pageData.taskSource ?? settings.defaultTaskSource,
        visibleTaskProviders
      )
    )
    setRepoSelection(resolvedInitialSelection)
    const nextGithubMode = taskResumeState?.githubMode ?? 'items'
    setGithubMode(nextGithubMode)
    const preset = taskResumeState?.githubItemsPreset
    if (preset === null) {
      const query = taskResumeState?.githubItemsQuery ?? ''
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(null)
    } else {
      const presetId = normalizeGitHubTaskPreset(preset ?? settings.defaultTaskViewPreset)
      const query = getTaskPresetQuery(presetId)
      setTaskSearchInput(query)
      setAppliedTaskSearch(query)
      setActiveTaskPreset(presetId)
    }
    const linearQuery = taskResumeState?.linearQuery ?? ''
    setLinearMode(taskResumeState?.linearMode ?? 'issues')
    setLinearSearchInput(linearQuery)
    setAppliedLinearSearch(linearQuery)
    const linearIssueView = loadLinearIssueView()
    setLinearViewMode(linearIssueView.viewMode)
    setLinearGroupBy(linearIssueView.groupBy)
    setLinearOrderBy(linearIssueView.orderBy)
    setLinearDisplayProperties(new Set(linearIssueView.displayProperties))
    setLinearTeamPropertyTouched(linearIssueView.teamPropertyTouched)
    setLinearIssueFiltersByWorkspaceId(linearIssueView.filtersByWorkspaceId)
    const jiraPreset = taskResumeState?.jiraPreset ?? 'assigned'
    const jiraQuery = taskResumeState?.jiraQuery ?? ''
    setActiveJiraPreset(jiraPreset)
    setJiraSearchInput(jiraQuery)
    setAppliedJiraSearch(jiraQuery)

    // Why: settings/UI hydrate async; apply the restored Tasks context exactly once so later source/filter clicks stay local.
    taskResumeAppliedRef.current = true
    setTaskResumeApplied(true)
  }, [
    persistedUIReady,
    settings,
    pageData.taskSource,
    resolvedInitialSelection,
    taskResumeState,
    visibleTaskProviders,
    setTaskSearchInput,
    setActiveTaskPreset,
    taskResumeAppliedRef,
    setActiveJiraPreset,
    setLinearMode,
    setLinearSearchInput,
    setAppliedLinearSearch,
    setAppliedTaskSearch,
    setTaskSource,
    setJiraSearchInput,
    setLinearOrderBy,
    setRepoSelection,
    setLinearDisplayProperties,
    setLinearIssueFiltersByWorkspaceId,
    setGithubMode,
    setLinearTeamPropertyTouched,
    setAppliedJiraSearch,
    setTaskResumeApplied,
    setLinearGroupBy,
    setLinearViewMode
  ])
  useEffect(() => {
    const context = taskResumeState?.linearContext
    if (
      linearContextResumeAttemptedRef.current ||
      !taskResumeApplied ||
      taskSource !== 'linear' ||
      !linearConnected ||
      !context
    ) {
      return
    }
    linearContextResumeAttemptedRef.current = true
    let cancelled = false
    if (context.kind === 'project') {
      void fetchLinearProject(context.id, context.workspaceId, {
        force: true,
        sourceContext: linearTaskSourceContext
      })
        .then((project) => {
          if (cancelled) {
            return
          }
          if (!project) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectParentView(null)
            setLinearProjectsError('Saved Linear project was not found.')
            setTaskResumeState({
              linearContext: undefined
            })
            return
          }
          setSelectedLinearProject(project)
          setSelectedLinearProjectDetail(project)
          setLinearMode('projects')
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedLinearProject(null)
            setSelectedLinearProjectDetail(null)
            setLinearProjectParentView(null)
            setLinearProjectsError('Failed to restore saved Linear project.')
            setTaskResumeState({
              linearContext: undefined
            })
          }
        })
      return () => {
        cancelled = true
      }
    }
    if (context.kind === 'view' && context.model) {
      setLinearMode('views')
      setLinearCustomViewsLoading(true)
      setLinearCustomViewsError(null)
      void fetchLinearCustomView(context.id, context.workspaceId, context.model, {
        force: true,
        sourceContext: linearTaskSourceContext
      })
        .then((restoredView) => {
          if (cancelled) {
            return
          }
          setLinearCustomViewsLoading(false)
          if (!restoredView) {
            setSelectedLinearCustomView(null)
            setLinearCustomViewsError('Saved Linear view was not found.')
            setTaskResumeState({
              linearContext: undefined
            })
            return
          }
          setSelectedLinearCustomView(restoredView)
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedLinearCustomView(null)
            setLinearCustomViewsLoading(false)
            setLinearCustomViewsError('Failed to restore saved Linear view.')
            setTaskResumeState({
              linearContext: undefined
            })
          }
        })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [
    fetchLinearCustomView,
    fetchLinearProject,
    listLinearCustomViews,
    linearConnected,
    linearTaskSourceContext,
    setTaskResumeState,
    taskResumeApplied,
    taskResumeState?.linearContext,
    taskSource,
    setSelectedLinearCustomView,
    setLinearCustomViewsError,
    setSelectedLinearProject,
    linearContextResumeAttemptedRef,
    setLinearProjectParentView,
    setLinearProjectsError,
    setLinearMode,
    setSelectedLinearProjectDetail,
    setLinearCustomViewsLoading
  ])

  // Why: fetch the full Linear team list so the selector shows all teams, not just those with issues in the fetch window.
  return model
}
export type TaskPageResumeRestorationModel = ReturnType<typeof useTaskPageResumeRestoration>
