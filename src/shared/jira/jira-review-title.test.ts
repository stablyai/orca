import { describe, expect, it } from 'vitest'
import { getWorkspaceJiraIssueKey } from './jira-review-title'
import type { WorkspaceAttachment } from '../worktree/types'

function jira(key: string, site = 'https://jira.example.com/jira'): WorkspaceAttachment {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    jiraIdentifier: key,
    url: `${site}/browse/${key.toLowerCase()}`
  }
}

describe('getWorkspaceJiraIssueKey', () => {
  it('rejects conflicting URLs and non-Jira source identities', () => {
    expect(
      getWorkspaceJiraIssueKey({ linkedItems: [{ ...jira('ALT-42'), url: jira('ALT-43').url }] })
    ).toBeNull()
    expect(
      getWorkspaceJiraIssueKey({ linkedItems: [{ ...jira('ALT-42'), provider: 'linear' }] })
    ).toBeNull()
    expect(
      getWorkspaceJiraIssueKey({
        linkedItems: [{ ...jira('ALT-42'), url: 'https://github.com/team/repo/issues/42' }]
      })
    ).toBeNull()
    expect(getWorkspaceJiraIssueKey(null)).toBeNull()
  })
  it('does not choose an arbitrary key among several attached tasks', () => {
    expect(getWorkspaceJiraIssueKey({ linkedItems: [jira('ALT-42'), jira('ALT-43')] })).toBeNull()
    expect(
      getWorkspaceJiraIssueKey({
        linkedItems: [jira('ALT-42'), jira('ALT-42', 'https://jira.other.com')]
      })
    ).toBe('ALT-42')
    expect(
      getWorkspaceJiraIssueKey({
        linkedWorkItem: {
          ...jira('ALT-43'),
          provider: 'jira',
          url: jira('ALT-43').url ?? '',
          title: ''
        },
        linkedItems: [jira('ALT-42')]
      })
    ).toBe('ALT-43')
  })
})
