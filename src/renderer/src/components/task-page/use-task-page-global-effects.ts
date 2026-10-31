import type { TaskPageJiraSummaryGenerationModel } from './jira/use-task-page-jira-summary-generation'
import { useEffect } from 'react'
import { useTaskPageEscapeToClose } from './use-task-page-escape-to-close'
export function useTaskPageGlobalEffects(model: TaskPageJiraSummaryGenerationModel) {
  const {
    closeTaskPage,
    activeModal,
    linearStatusContextKey,
    preflightStatusChecked,
    preflightStatusContextKey,
    checkLinearConnection,
    refreshPreflightStatus,
    expectedPreflightContextKey,
    jiraStatusContextKey,
    checkJiraConnection,
    providerRuntimeContextKey,
    preflightStatusCurrent,
    linearStatusReady,
    jiraStatusReady,
    tasksLoading,
    tasksRefreshing,
    tasksFiltering,
    dialogWorkItem,
    newIssueOpen,
    selectedLinearIssue,
    selectedJiraIssue,
    newLinearIssueOpen,
    newJiraIssueOpen
  } = model
  const githubTasksBusy = tasksLoading || tasksRefreshing || tasksFiltering
  useTaskPageEscapeToClose(
    Boolean(
      dialogWorkItem ||
      selectedJiraIssue ||
      selectedLinearIssue ||
      newIssueOpen ||
      newLinearIssueOpen ||
      newJiraIssueOpen ||
      activeModal !== 'none'
    ),
    closeTaskPage
  )
  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusReady) {
      void checkLinearConnection()
    }
    if (!jiraStatusReady) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    expectedPreflightContextKey,
    jiraStatusContextKey,
    jiraStatusReady,
    linearStatusContextKey,
    linearStatusReady,
    providerRuntimeContextKey,
    preflightStatusContextKey,
    preflightStatusChecked,
    preflightStatusCurrent,
    refreshPreflightStatus
  ])

  const nextModel = model as typeof model & {
    githubTasksBusy: typeof githubTasksBusy
  }
  nextModel.githubTasksBusy = githubTasksBusy
  return nextModel
}
export type TaskPageGlobalEffectsModel = ReturnType<typeof useTaskPageGlobalEffects>
