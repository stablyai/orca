import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { createJiraCollectionReadActions } from './jira-collection-read-actions'
import { createJiraConnectionActions } from './jira-connection-actions'
import { createJiraIssuePatchAction } from './jira-issue-patch-action'
import { createJiraIssueReadActions } from './jira-issue-read-actions'
import type { JiraSlice } from './jira-slice-contract'

export type { JiraSlice } from './jira-slice-contract'

export const createJiraSlice: StateCreator<AppState, [], [], JiraSlice> = (set, get) => ({
  jiraStatus: { connected: false, viewer: null },
  jiraStatusChecked: false,
  jiraStatusContextKey: null,
  jiraConnectionRevisions: {},
  jiraIssueCache: {},
  jiraIssueSummaryCache: {},
  jiraSearchCache: {},
  ...createJiraConnectionActions(set, get),
  ...createJiraIssueReadActions(set, get),
  ...createJiraCollectionReadActions(set, get),
  ...createJiraIssuePatchAction(set)
})
