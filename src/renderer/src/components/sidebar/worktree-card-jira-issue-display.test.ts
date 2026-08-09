import { describe, expect, it } from 'vitest'
import {
  getConfiguredWorktreeCardJiraIssueDisplay,
  getWorktreeCardJiraIssueDisplay
} from './worktree-card-jira-issue-display'

describe('getWorktreeCardJiraIssueDisplay', () => {
  it('prefers dedicated Jira issue metadata over a linked review item', () => {
    expect(
      getWorktreeCardJiraIssueDisplay({
        linkedJiraIssue: {
          key: 'KAN-2',
          title: 'Dedicated Jira metadata',
          url: 'https://company.atlassian.net/browse/KAN-2'
        },
        linkedWorkItem: {
          provider: 'gitlab',
          type: 'mr',
          number: 42,
          title: 'Preserved review',
          url: 'https://gitlab.example.com/group/repo/-/merge_requests/42'
        }
      })
    ).toEqual({
      identifier: 'KAN-2',
      title: 'Dedicated Jira metadata',
      url: 'https://company.atlassian.net/browse/KAN-2'
    })
  })

  it('projects persisted Jira linked-item metadata for the workspace card', () => {
    expect(
      getWorktreeCardJiraIssueDisplay({
        linkedJiraIssue: undefined,
        linkedWorkItem: {
          provider: 'jira',
          type: 'issue',
          number: 1,
          jiraIdentifier: 'KAN-1',
          title: 'KAN-1 Test Jira card icon',
          url: 'https://company.atlassian.net/browse/KAN-1'
        }
      })
    ).toEqual({
      identifier: 'KAN-1',
      title: 'Test Jira card icon',
      url: 'https://company.atlassian.net/browse/KAN-1'
    })
  })

  it('does not infer Jira from another provider', () => {
    expect(
      getWorktreeCardJiraIssueDisplay({
        linkedJiraIssue: undefined,
        linkedWorkItem: {
          provider: 'linear',
          type: 'issue',
          number: 1,
          linearIdentifier: 'ENG-1',
          title: 'Linear issue',
          url: 'https://linear.app/acme/issue/ENG-1'
        }
      })
    ).toBeNull()
  })

  it('shows persisted Jira metadata only when the Jira display property is enabled', () => {
    const worktree = {
      linkedJiraIssue: undefined,
      linkedWorkItem: {
        provider: 'jira' as const,
        type: 'issue' as const,
        number: 1,
        jiraIdentifier: 'KAN-1',
        title: 'Test Jira card preference',
        url: 'https://company.atlassian.net/browse/KAN-1'
      }
    }

    expect(getConfiguredWorktreeCardJiraIssueDisplay(worktree, [])).toBeNull()
    expect(getConfiguredWorktreeCardJiraIssueDisplay(worktree, ['jira-issue'])).toMatchObject({
      identifier: 'KAN-1',
      title: 'Test Jira card preference'
    })
  })
})
