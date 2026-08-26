import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

import { loadLinearIssueView } from '@/components/linear-issue-view-storage'
import { translate } from '@/i18n/i18n'
import { normalizeGitHubTaskPreset } from '@/components/task-page-github-task-kind'
import type {
  JiraPresetId,
  LinearDisplayProperty,
  LinearGroupBy,
  LinearMode,
  LinearOrderBy,
  LinearViewMode
} from '@/components/task-page-localized-options'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { LinearIssueAttributeFilter } from '../../../../../shared/linear/issue-attribute-filter'
import type {
  LinearCustomViewSummary,
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'
import { getTaskPresetQuery } from '../../../../../shared/task-preset-query'
import { resolveVisibleTaskProvider, type TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'

export function useTaskPageSessionResume({
  persistedUIReady,
  settings,
  pageData,
  resolvedInitialSelection,
  taskResumeState,
  visibleTaskProviders,
  setTaskSource,
  setRepoSelection,
  setGithubMode,
  setTaskSearchInput,
  setAppliedTaskSearch,
  setActiveTaskPreset,
  setLinearMode,
  setLinearSearchInput,
  setAppliedLinearSearch,
  setLinearViewMode,
  setLinearGroupBy,
  setLinearOrderBy,
  setLinearDisplayProperties,
  setLinearTeamPropertyTouched,
  setLinearIssueFiltersByWorkspaceId,
  setActiveJiraPreset,
  setJiraSearchInput,
  setAppliedJiraSearch,
  taskResumeAppliedRef,
  setTaskResumeApplied,
  linearContextResumeAttemptedRef,
  taskResumeApplied,
  taskSource,
  linearConnected,
  fetchLinearProject,
  fetchLinearCustomView,
  listLinearCustomViews,
  linearTaskSourceContext,
  setTaskResumeState,
  setSelectedLinearProject,
  setSelectedLinearProjectDetail,
  setLinearProjectParentView,
  setLinearProjectsError,
  setLinearCustomViewsLoading,
  setLinearCustomViewsError,
  setSelectedLinearCustomView
}: {
  persistedUIReady: boolean
  settings: GlobalSettings | null
  pageData: { taskSource?: TaskProvider }
  resolvedInitialSelection: ReadonlySet<string>
  taskResumeState: AppState['taskResumeState']
  visibleTaskProviders: TaskProvider[]
  setTaskSource: Dispatch<SetStateAction<TaskProvider>>
  setRepoSelection: Dispatch<SetStateAction<ReadonlySet<string>>>
  setGithubMode: Dispatch<SetStateAction<'items' | 'project'>>
  setTaskSearchInput: Dispatch<SetStateAction<string>>
  setAppliedTaskSearch: Dispatch<SetStateAction<string>>
  setActiveTaskPreset: Dispatch<SetStateAction<TaskViewPresetId | null>>
  setLinearMode: Dispatch<SetStateAction<LinearMode>>
  setLinearSearchInput: Dispatch<SetStateAction<string>>
  setAppliedLinearSearch: Dispatch<SetStateAction<string>>
  setLinearViewMode: Dispatch<SetStateAction<LinearViewMode>>
  setLinearGroupBy: Dispatch<SetStateAction<LinearGroupBy>>
  setLinearOrderBy: Dispatch<SetStateAction<LinearOrderBy>>
  setLinearDisplayProperties: Dispatch<SetStateAction<ReadonlySet<LinearDisplayProperty>>>
  setLinearTeamPropertyTouched: Dispatch<SetStateAction<boolean>>
  setLinearIssueFiltersByWorkspaceId: Dispatch<
    SetStateAction<Record<string, LinearIssueAttributeFilter>>
  >
  setActiveJiraPreset: Dispatch<SetStateAction<JiraPresetId>>
  setJiraSearchInput: Dispatch<SetStateAction<string>>
  setAppliedJiraSearch: Dispatch<SetStateAction<string>>
  taskResumeAppliedRef: MutableRefObject<boolean>
  setTaskResumeApplied: Dispatch<SetStateAction<boolean>>
  linearContextResumeAttemptedRef: MutableRefObject<boolean>
  taskResumeApplied: boolean
  taskSource: TaskProvider
  linearConnected: boolean
  fetchLinearProject: AppState['fetchLinearProject']
  fetchLinearCustomView: AppState['fetchLinearCustomView']
  listLinearCustomViews: AppState['listLinearCustomViews']
  linearTaskSourceContext: TaskSourceContext | null
  setTaskResumeState: AppState['setTaskResumeState']
  setSelectedLinearProject: Dispatch<SetStateAction<LinearProjectSummary | null>>
  setSelectedLinearProjectDetail: Dispatch<SetStateAction<LinearProjectDetail | null>>
  setLinearProjectParentView: Dispatch<SetStateAction<LinearCustomViewSummary | null>>
  setLinearProjectsError: Dispatch<SetStateAction<string | null>>
  setLinearCustomViewsLoading: Dispatch<SetStateAction<boolean>>
  setLinearCustomViewsError: Dispatch<SetStateAction<string | null>>
  setSelectedLinearCustomView: Dispatch<SetStateAction<LinearCustomViewSummary | null>>
}): void {
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

    const preset = taskResumeState?.githubItemsPreset
    if (preset === null) {
      const query = taskResumeState?.githubItemsQuery ?? ''
      void (setTaskSearchInput(query), setAppliedTaskSearch(query))
      setActiveTaskPreset(null)
    } else {
      const presetId = normalizeGitHubTaskPreset(preset ?? settings.defaultTaskViewPreset)
      const query = getTaskPresetQuery(presetId)
      void (setTaskSearchInput(query), setAppliedTaskSearch(query))
      setActiveTaskPreset(presetId)
    }

    const linearQuery = taskResumeState?.linearQuery ?? ''
    setLinearMode(taskResumeState?.linearMode ?? 'issues')
    void (setLinearSearchInput(linearQuery), setAppliedLinearSearch(linearQuery))

    const linearIssueView = loadLinearIssueView()
    void (setLinearViewMode(linearIssueView.viewMode), setLinearGroupBy(linearIssueView.groupBy))
    void (setLinearOrderBy(linearIssueView.orderBy),
    setLinearDisplayProperties(new Set(linearIssueView.displayProperties)))
    void (setLinearTeamPropertyTouched(linearIssueView.teamPropertyTouched),
    setLinearIssueFiltersByWorkspaceId(linearIssueView.filtersByWorkspaceId))

    const jiraPreset = taskResumeState?.jiraPreset ?? 'assigned'
    const jiraQuery = taskResumeState?.jiraQuery ?? ''
    void (setActiveJiraPreset(jiraPreset), setJiraSearchInput(jiraQuery))
    void (setAppliedJiraSearch(jiraQuery), setGithubMode(nextGithubMode))

    // Why: settings/UI hydrate async; apply the restored Tasks context exactly once so later source/filter clicks stay local.
    void ((taskResumeAppliedRef.current = true), setTaskResumeApplied(true))
    // Dependency list intentionally includes every restored state setter used above.
  }, [
    persistedUIReady,
    settings,
    pageData.taskSource,
    resolvedInitialSelection,
    taskResumeState,
    visibleTaskProviders,
    taskResumeAppliedRef,
    setTaskSearchInput,
    setActiveTaskPreset,
    setLinearIssueFiltersByWorkspaceId,
    setActiveJiraPreset,
    setLinearMode,
    setLinearSearchInput,
    setTaskSource,
    setAppliedLinearSearch,
    setLinearOrderBy,
    setAppliedTaskSearch,
    setLinearDisplayProperties,
    setLinearTeamPropertyTouched,
    setJiraSearchInput,
    setLinearViewMode,
    setLinearGroupBy,
    setTaskResumeApplied,
    setRepoSelection,
    setAppliedJiraSearch,
    setGithubMode
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
            setLinearProjectsError(
              translate(
                'auto.components.task.page.hooks.use.task.page.session.resume.savedLinearProjectMissing',
                'Saved Linear project was not found.'
              )
            )
            setTaskResumeState({ linearContext: undefined })
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
            setLinearProjectsError(
              translate(
                'auto.components.task.page.hooks.use.task.page.session.resume.savedLinearProjectRestoreFailed',
                'Failed to restore saved Linear project.'
              )
            )
            setTaskResumeState({ linearContext: undefined })
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
            setLinearCustomViewsError(
              translate(
                'auto.components.task.page.hooks.use.task.page.session.resume.savedLinearViewMissing',
                'Saved Linear view was not found.'
              )
            )
            setTaskResumeState({ linearContext: undefined })
            return
          }
          setSelectedLinearCustomView(restoredView)
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedLinearCustomView(null)
            setLinearCustomViewsLoading(false)
            setLinearCustomViewsError(
              translate(
                'auto.components.task.page.hooks.use.task.page.session.resume.savedLinearViewRestoreFailed',
                'Failed to restore saved Linear view.'
              )
            )
            setTaskResumeState({ linearContext: undefined })
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
    linearContextResumeAttemptedRef,
    setSelectedLinearProject,
    setLinearProjectParentView,
    setLinearMode,
    setLinearProjectsError,
    setLinearCustomViewsError,
    setSelectedLinearCustomView,
    setSelectedLinearProjectDetail,
    setLinearCustomViewsLoading
  ])
}
