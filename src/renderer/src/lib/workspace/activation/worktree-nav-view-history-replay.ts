import { useAppStore } from '@/store/index'
import type { WorktreeNavHistoryViewEntry } from '@/store/slices/ui/workspace-navigation-history'

// Replay via setActiveView: open*Page would mutate previousViewBefore* or duplicate history (navigateToIndex).
export function applyWorktreeNavViewEntry(entry: WorktreeNavHistoryViewEntry): void {
  if (entry === 'automations' || entry === 'artifacts' || entry === 'skills') {
    if (entry === 'automations') {
      // Why: Back/Forward is a user navigation; the page focuses its title once it settles.
      useAppStore.setState({ automationsPageFocusTitleOnOpen: true })
    }
    useAppStore.getState().setActiveView(entry)
    return
  }
  if (typeof entry === 'object' && entry.kind === 'automations-page') {
    // Why: the page owns its sub-page state; it applies this request and clears it.
    useAppStore.setState({
      activeView: 'automations',
      automationsPageLocationRequest: entry.location,
      automationsPageFocusTitleOnOpen: true
    })
    return
  }
  if (entry === 'tasks') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'github') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'github',
        preselectedRepoId: entry.workItem.repoId,
        openGitHubWorkItem: entry.workItem,
        openGitHubSourceContext: entry.sourceContext,
        openGitHubInitialTab: entry.initialTab,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'gitlab') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'gitlab',
        preselectedRepoId: entry.workItem.repoId,
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: entry.workItem,
        openGitLabSourceContext: entry.sourceContext,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: undefined,
        openJiraSourceContext: undefined
      }
    }))
    return
  }
  if (entry.source === 'jira') {
    useAppStore.setState((state) => ({
      activeView: 'tasks',
      githubTaskDrawerWorkItem: null,
      taskPageData: {
        ...state.taskPageData,
        taskSource: 'jira',
        openGitHubWorkItem: undefined,
        openGitHubSourceContext: undefined,
        openGitHubInitialTab: undefined,
        openGitLabWorkItem: undefined,
        openGitLabSourceContext: undefined,
        openLinearIssue: undefined,
        openLinearSourceContext: undefined,
        openJiraIssue: entry.issue,
        openJiraSourceContext: entry.sourceContext
      }
    }))
    return
  }
  useAppStore.setState((state) => ({
    activeView: 'tasks',
    githubTaskDrawerWorkItem: null,
    taskPageData: {
      ...state.taskPageData,
      taskSource: 'linear',
      openGitHubWorkItem: undefined,
      openGitHubSourceContext: undefined,
      openGitHubInitialTab: undefined,
      openGitLabWorkItem: undefined,
      openGitLabSourceContext: undefined,
      openLinearIssue: entry.issue,
      openLinearSourceContext: entry.sourceContext,
      openJiraIssue: undefined,
      openJiraSourceContext: undefined
    }
  }))
}
