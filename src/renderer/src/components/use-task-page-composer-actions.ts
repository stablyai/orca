import type { TaskPageJiraListEffectsModel } from './use-task-page-jira-list-effects'
import { useCallback } from 'react'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearWorkspaceSelection } from '../../../shared/linear/workspace-types'
import type { JiraIssue } from '../../../shared/jira-types'
import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { useAppStore } from '@/store'
import { openLinearIssueWorkspaceOrStart } from '@/lib/linear-issue-workspace-open'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { bindTaskPageJiraItemSourceContext } from './task-page-jira-item-source-context'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldHideTaskPageListChrome } from '@/components/task-page-list-chrome-visibility'
import { getJiraIssueWorkspaceSeed } from './task-page-source-context'
export function useTaskPageComposerActions(model: TaskPageJiraListEffectsModel) {
  const {
    setTaskResumeState,
    openModal,
    updateSettings,
    selectLinearWorkspace,
    listLinearTeams,
    checkLinearConnection,
    selectedLinearWorkspaceId,
    jiraSites,
    taskSource,
    linearTaskSourceContext,
    jiraTaskSourceContext,
    gitlabDialogItem,
    dialogWorkItem,
    selectedLinearIssue,
    clearSelectedLinearIssue,
    selectedJiraIssue,
    linearMode,
    setLinearIssues,
    setLinearLoading,
    setLinearError,
    setLinearRefreshNonce,
    setLinearProjectsResult,
    setLinearProjectsError,
    selectedLinearProject,
    setSelectedLinearProject,
    setSelectedLinearProjectDetail,
    setLinearProjectDetailError,
    setLinearProjectTab,
    setLinearProjectIssuesResult,
    setLinearCustomViewsResult,
    setLinearCustomViewsError,
    selectedLinearCustomView,
    setSelectedLinearCustomView,
    setLinearProjectParentView,
    setLinearCustomViewIssuesResult,
    setLinearCustomViewProjectsResult,
    setLinearCustomViewContentsError,
    linearContextResumeAttemptedRef,
    setAvailableTeams,
    setLinearTeamRefreshNonce,
    setLinearTeamSelection
  } = model
  // Why: Linear ids are strings (e.g. "ENG-123") but the provider-generic shape needs a numeric number, so the adapter uses 0 as placeholder.
  const openComposerForLinearItem = useCallback(
    (issue: LinearIssue): void => {
      const linkedWorkItem = buildLinearIssueLinkedWorkItem(issue)
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext: linearTaskSourceContext,
        prefilledName: getLinearIssueWorkspaceName(issue),
        telemetrySource: 'sidebar'
      })
    },
    [linearTaskSourceContext, openModal]
  )
  const handleUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      // Why: like handleUseWorkItem — open the pre-filled dialog instead of creating the worktree directly, so the user confirms name/agent/setup.
      useAppStore.getState().recordFeatureInteraction('linear-tasks')
      openComposerForLinearItem(issue)
    },
    [openComposerForLinearItem]
  )
  const handleOpenOrUseLinearItem = useCallback(
    (issue: LinearIssue): void => {
      if (openLinearIssueWorkspaceOrStart(issue, () => handleUseLinearItem(issue)) === 'opened') {
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
      }
    },
    [handleUseLinearItem]
  )
  const handleLinearWorkspaceChange = useCallback(
    (workspaceId: LinearWorkspaceSelection): void => {
      clearSelectedLinearIssue()
      setSelectedLinearProject(null)
      setSelectedLinearProjectDetail(null)
      setSelectedLinearCustomView(null)
      setLinearProjectParentView(null)
      setLinearProjectTab('overview')
      setLinearProjectsResult({
        items: []
      })
      setLinearCustomViewsResult({
        items: []
      })
      setLinearProjectIssuesResult({
        items: []
      })
      setLinearCustomViewIssuesResult({
        items: []
      })
      setLinearCustomViewProjectsResult({
        items: []
      })
      setLinearProjectDetailError(null)
      setLinearProjectsError(null)
      setLinearCustomViewsError(null)
      setLinearCustomViewContentsError(null)
      setTaskResumeState({
        linearMode,
        linearContext: undefined
      })
      linearContextResumeAttemptedRef.current = false
      setLinearIssues([])
      setLinearError(null)
      setLinearLoading(true)
      void selectLinearWorkspace(workspaceId)
        .then(() => {
          setLinearTeamRefreshNonce((n) => n + 1)
        })
        .catch(() => {
          setLinearLoading(false)
          toast.error(
            translate('auto.components.TaskPage.d0d570b306', 'Failed to switch Linear workspace.')
          )
        })
    },
    [
      clearSelectedLinearIssue,
      linearMode,
      selectLinearWorkspace,
      setTaskResumeState,
      linearContextResumeAttemptedRef,
      setSelectedLinearProjectDetail,
      setLinearProjectTab,
      setLinearProjectsError,
      setLinearProjectsResult,
      setLinearCustomViewIssuesResult,
      setLinearCustomViewsError,
      setSelectedLinearProject,
      setSelectedLinearCustomView,
      setLinearTeamRefreshNonce,
      setLinearProjectParentView,
      setLinearProjectIssuesResult,
      setLinearCustomViewsResult,
      setLinearCustomViewProjectsResult,
      setLinearError,
      setLinearLoading,
      setLinearProjectDetailError,
      setLinearCustomViewContentsError,
      setLinearIssues
    ]
  )
  const handleLinearTeamSelectionChange = useCallback(
    (next: ReadonlySet<string>, persisted: string[] | null): void => {
      setLinearTeamSelection(new Set(next))
      void updateSettings({
        defaultLinearTeamSelection: persisted
      }).catch(() => {
        toast.error(
          translate('auto.components.TaskPage.3f594861a5', 'Failed to save team selection.')
        )
      })
    },
    [updateSettings, setLinearTeamSelection]
  )
  const handleLinearScopeOpen = useCallback((): void => {
    void checkLinearConnection(true)
    void listLinearTeams(selectedLinearWorkspaceId, {
      force: true
    })
      .then((teams) => {
        setAvailableTeams(teams)
      })
      .catch(() => {
        console.warn('[TaskPage] Failed to refresh Linear teams')
      })
  }, [checkLinearConnection, listLinearTeams, selectedLinearWorkspaceId, setAvailableTeams])
  const handleLinearAccessConnected = useCallback((): void => {
    setLinearTeamRefreshNonce((n) => n + 1)
    setLinearRefreshNonce((n) => n + 1)
  }, [setLinearTeamRefreshNonce, setLinearRefreshNonce])
  const openComposerForJiraItem = useCallback(
    (issue: JiraIssue): void => {
      const taskSourceContext = bindTaskPageJiraItemSourceContext({
        issue,
        sites: jiraSites,
        sourceContext: jiraTaskSourceContext
      })
      if (!taskSourceContext) {
        // Why: composer drops Jira items without matching source context — refuse rather than create unlinked.
        toast.error(
          translate(
            'auto.components.TaskPage.jiraLinkSourceUnavailable',
            'Couldn’t link this Jira issue. Reconnect Jira or pick the matching site, then try again.'
          )
        )
        return
      }
      const linkedWorkItem: LinkedWorkItemSummary = {
        type: 'issue',
        provider: 'jira',
        number: 0,
        title: `${issue.key} ${issue.title}`,
        url: issue.url,
        jiraIdentifier: issue.key
      }
      openModal('new-workspace-composer', {
        linkedWorkItem,
        taskSourceContext,
        prefilledName: getJiraIssueWorkspaceSeed(issue),
        telemetrySource: 'sidebar'
      })
    },
    [jiraSites, jiraTaskSourceContext, openModal]
  )
  const handleUseJiraItem = useCallback(
    (issue: JiraIssue): void => {
      useAppStore.getState().recordFeatureInteraction('jira-tasks')
      openComposerForJiraItem(issue)
    },
    [openComposerForJiraItem]
  )
  const taskPageListChromeHidden = shouldHideTaskPageListChrome({
    taskSource,
    hasGitHubDetail: Boolean(dialogWorkItem),
    hasGitLabDetail: Boolean(gitlabDialogItem),
    hasJiraDetail: Boolean(selectedJiraIssue),
    hasLinearIssueDetail: Boolean(selectedLinearIssue),
    hasLinearProjectContext: Boolean(selectedLinearProject),
    hasLinearViewContext: Boolean(selectedLinearCustomView)
  })
  const nextModel = model as typeof model & {
    openComposerForLinearItem: typeof openComposerForLinearItem
    handleUseLinearItem: typeof handleUseLinearItem
    handleOpenOrUseLinearItem: typeof handleOpenOrUseLinearItem
    handleLinearWorkspaceChange: typeof handleLinearWorkspaceChange
    handleLinearTeamSelectionChange: typeof handleLinearTeamSelectionChange
    handleLinearScopeOpen: typeof handleLinearScopeOpen
    handleLinearAccessConnected: typeof handleLinearAccessConnected
    openComposerForJiraItem: typeof openComposerForJiraItem
    handleUseJiraItem: typeof handleUseJiraItem
    taskPageListChromeHidden: typeof taskPageListChromeHidden
  }
  nextModel.openComposerForLinearItem = openComposerForLinearItem
  nextModel.handleUseLinearItem = handleUseLinearItem
  nextModel.handleOpenOrUseLinearItem = handleOpenOrUseLinearItem
  nextModel.handleLinearWorkspaceChange = handleLinearWorkspaceChange
  nextModel.handleLinearTeamSelectionChange = handleLinearTeamSelectionChange
  nextModel.handleLinearScopeOpen = handleLinearScopeOpen
  nextModel.handleLinearAccessConnected = handleLinearAccessConnected
  nextModel.openComposerForJiraItem = openComposerForJiraItem
  nextModel.handleUseJiraItem = handleUseJiraItem
  nextModel.taskPageListChromeHidden = taskPageListChromeHidden
  return nextModel
}
export type TaskPageComposerActionsModel = ReturnType<typeof useTaskPageComposerActions>
