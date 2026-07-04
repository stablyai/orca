import type { TaskProvider } from '../../../shared/types'

export type TaskPageListChromeVisibilityState = {
  taskSource: TaskProvider
  hasGitHubDetail: boolean
  hasGitLabDetail: boolean
  hasJiraDetail: boolean
  // Optional until the Gitea detail panel is wired into TaskPage.
  hasGiteaDetail?: boolean
  hasLinearIssueDetail: boolean
  hasLinearProjectContext: boolean
  hasLinearViewContext: boolean
}

export function shouldHideTaskPageListChrome({
  taskSource,
  hasGitHubDetail,
  hasGitLabDetail,
  hasJiraDetail,
  hasGiteaDetail,
  hasLinearIssueDetail,
  hasLinearProjectContext,
  hasLinearViewContext
}: TaskPageListChromeVisibilityState): boolean {
  // Why: provider-specific selection can intentionally survive source switches;
  // stale detail state from another provider must not hide the active list chrome.
  switch (taskSource) {
    case 'github':
      return hasGitHubDetail
    case 'gitlab':
      return hasGitLabDetail
    case 'jira':
      return hasJiraDetail
    case 'gitea':
      return hasGiteaDetail === true
    case 'linear':
      return hasLinearIssueDetail || hasLinearProjectContext || hasLinearViewContext
  }
}
