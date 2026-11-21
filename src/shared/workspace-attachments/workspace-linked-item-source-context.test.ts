import { describe, expect, it } from 'vitest'
import type { TaskSourceContext } from '../work-items/task-source-context'
import type { WorkspaceLinkedItem } from '../worktree/types'
import { isWorkspaceLinkedItemSourceContextMatch } from './workspace-linked-item-source-context'

const JIRA_ITEM: WorkspaceLinkedItem = {
  provider: 'jira',
  type: 'issue',
  number: 0,
  title: 'ORCA-123 Link Jira',
  url: 'https://company.atlassian.net/jira/browse/ORCA-123',
  jiraIdentifier: 'ORCA-123'
}

const JIRA_CONTEXT: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'local',
  providerIdentity: {
    provider: 'jira',
    siteId: 'site-1',
    siteUrl: 'https://company.atlassian.net/jira',
    projectKey: 'ORCA'
  }
}

describe('workspace linked-item source context', () => {
  it('requires Jira key, site URL, site account, and project identity to agree', () => {
    expect(isWorkspaceLinkedItemSourceContextMatch(JIRA_ITEM, JIRA_CONTEXT)).toBe(true)
    expect(
      isWorkspaceLinkedItemSourceContextMatch(JIRA_ITEM, {
        ...JIRA_CONTEXT,
        providerIdentity: {
          ...JIRA_CONTEXT.providerIdentity!,
          provider: 'jira',
          siteUrl: 'https://other.atlassian.net'
        }
      })
    ).toBe(false)
    expect(
      isWorkspaceLinkedItemSourceContextMatch(JIRA_ITEM, {
        ...JIRA_CONTEXT,
        providerIdentity: {
          ...JIRA_CONTEXT.providerIdentity!,
          provider: 'jira',
          projectKey: 'OTHER'
        }
      })
    ).toBe(false)
    expect(
      isWorkspaceLinkedItemSourceContextMatch(
        { ...JIRA_ITEM, jiraIdentifier: 'ORCA-999' },
        JIRA_CONTEXT
      )
    ).toBe(false)
  })
})
