import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from '../../../../../shared/jira/jira-types'
import type { WorkspaceAttachment } from '../../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { makeWorktree } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
import {
  buildJiraIssueWorkspaceAttachmentIndex,
  collectLinkedJiraIssueRefs,
  findJiraIssueWorkspaceAttachmentsInIndex
} from './jira-issue-workspace-attachment'

const issue: JiraIssue = {
  id: '10001',
  key: 'PROJ-1',
  siteId: 'site-1',
  title: 'Example issue',
  url: 'https://jira.example.com/browse/PROJ-1',
  project: { id: 'p', key: 'PROJ', name: 'Project' },
  issueType: { id: 'task', name: 'Task' },
  status: {
    id: 'open',
    name: 'In Progress',
    categoryKey: 'indeterminate',
    categoryName: 'In Progress'
  },
  labels: [],
  updatedAt: '2026-11-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z'
}
const site: JiraSite = {
  id: 'site-1',
  siteUrl: 'https://jira.example.com',
  email: 'me@example.com',
  displayName: 'Me',
  accountId: 'me'
}
// What `orca reference add` stores: a link without a taskSourceContext.
const linkWithoutTaskSourceContext: WorkspaceAttachment = {
  provider: 'jira',
  type: 'issue',
  number: 0,
  url: issue.url,
  jiraIdentifier: issue.key
}
const runtimeSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'account-backed-task-source',
  hostId: 'runtime:env-1',
  providerIdentity: {
    provider: 'jira',
    siteId: 'site-1',
    siteUrl: 'https://jira.example.com',
    projectKey: 'PROJ'
  }
}

describe('jira issue workspace attachment host matching', () => {
  it('counts a link without a taskSourceContext for the runtime of its workspace', () => {
    const workspace = makeWorktree('wt-remote', 'Remote', {
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1',
      linkedItems: [linkWithoutTaskSourceContext]
    })
    const index = buildJiraIssueWorkspaceAttachmentIndex([workspace])
    expect(findJiraIssueWorkspaceAttachmentsInIndex(index, issue, runtimeSource)).toHaveLength(1)
    expect(
      collectLinkedJiraIssueRefs([workspace], [site], 'all', runtimeSource).map((ref) => ref.key)
    ).toEqual(['PROJ-1'])
  })
})
