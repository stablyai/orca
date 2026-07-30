import type { WorktreeCreationRequest } from './pending-worktree-creation'

type LinkedWorkItem = NonNullable<WorktreeCreationRequest['linkedWorkItem']>
type LinkedTaskSourceContext = NonNullable<WorktreeCreationRequest['linkedTaskSourceContext']>
type WorkspaceRunContext = NonNullable<WorktreeCreationRequest['workspaceRunContext']>

export const LINKED_JIRA_WORK_ITEM = {
  provider: 'jira',
  type: 'issue',
  number: 0,
  title: 'ORCA-123 Durable Jira link',
  url: 'https://company.atlassian.net/browse/ORCA-123',
  jiraIdentifier: 'ORCA-123'
} satisfies LinkedWorkItem

export const LINKED_JIRA_TASK_SOURCE_CONTEXT = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'repo-1',
  providerIdentity: {
    provider: 'jira',
    siteId: 'site-1',
    siteUrl: 'https://company.atlassian.net',
    projectKey: 'ORCA'
  },
  accountLabel: 'dev@company.test'
} satisfies LinkedTaskSourceContext

export const RUNTIME_WORKSPACE_RUN_CONTEXT = {
  kind: 'workspace-run',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  projectHostSetupId: 'setup-1',
  repoId: 'repo-1',
  path: '/workspace/repo'
} satisfies WorkspaceRunContext
