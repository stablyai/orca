import type { TaskProvider } from '../../../../shared/work-items/task-providers'

export type TaskPageListChromeVisibilityState = {
  taskSource: TaskProvider
  hasGitHubDetail: boolean
  hasGitLabDetail: boolean
  hasJiraDetail: boolean
  hasLinearIssueDetail: boolean
  hasLinearProjectContext: boolean
  hasLinearViewContext: boolean
}

/** Considers only the active provider's detail state; Backlog keeps its own list controls visible. */
export function shouldHideTaskPageListChrome({
  taskSource,
  hasGitHubDetail,
  hasGitLabDetail,
  hasJiraDetail,
  hasLinearIssueDetail,
  hasLinearProjectContext,
  hasLinearViewContext
}: TaskPageListChromeVisibilityState): boolean {
  // Selections survive provider switches; another provider’s retained detail must not hide the active list chrome.
  switch (taskSource) {
    case 'backlog':
      return false
    case 'github':
      return hasGitHubDetail
    case 'gitlab':
      return hasGitLabDetail
    case 'jira':
      return hasJiraDetail
    case 'linear':
      return hasLinearIssueDetail || hasLinearProjectContext || hasLinearViewContext
  }
}
