import type { JiraIssue } from '../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { makeCmdJTaskSearchResult } from './task-search-results'

export const jiraTaskIssue: JiraIssue = {
  id: 'other-site-id',
  key: 'DEMO-12',
  siteId: 'other-site',
  title: 'Fix login redirect',
  url: 'https://other.atlassian.net/browse/DEMO-12',
  project: { id: 'p', key: 'DEMO', name: 'Demo' },
  issueType: { id: 'task', name: 'Task' },
  status: {
    id: 'open',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  labels: [],
  updatedAt: '2026-10-13T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z'
}
export const jiraTaskSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'account-backed-task-source',
  hostId: 'local',
  providerIdentity: {
    provider: 'jira',
    siteId: 'other-site',
    siteUrl: 'https://other.atlassian.net',
    projectKey: 'DEMO'
  },
  accountLabel: 'other@example.com'
}
export const jiraTaskResult = makeCmdJTaskSearchResult(
  { provider: 'jira', issue: jiraTaskIssue },
  jiraTaskSource,
  null,
  'Local'
)
