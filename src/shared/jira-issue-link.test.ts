import { describe, expect, it } from 'vitest'
import {
  isJiraIssueLinkSourceContextMatch,
  jiraIssueLinkFromLegacyWorkItem,
  normalizeJiraIssueLink,
  resolveJiraIssueLink,
  resolveJiraIssueSourceContext
} from './jira-issue-link'

const sourceContext = {
  kind: 'task-source' as const,
  provider: 'jira' as const,
  projectId: 'project-1',
  hostId: 'runtime:env-1' as const,
  providerIdentity: {
    provider: 'jira' as const,
    siteId: 'site-1',
    siteUrl: 'https://company.atlassian.net',
    projectKey: 'ORCA'
  }
}

describe('JiraIssueLink', () => {
  it('normalizes the issue key, title, and canonical URL', () => {
    expect(
      normalizeJiraIssueLink({
        key: ' orca-123 ',
        title: ' Link Jira ',
        url: 'HTTPS://COMPANY.ATLASSIAN.NET/browse/orca-123?focusedCommentId=1#comment'
      })
    ).toEqual({
      key: 'ORCA-123',
      title: 'Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123'
    })
  })

  it('rejects a key that does not match the canonical URL', () => {
    expect(
      normalizeJiraIssueLink({
        key: 'ORCA-124',
        title: 'Link Jira',
        url: 'https://company.atlassian.net/browse/ORCA-123'
      })
    ).toBeNull()
  })

  it('projects legacy Jira metadata without treating a review item as Jira', () => {
    expect(
      jiraIssueLinkFromLegacyWorkItem({
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'ORCA-123 Link Jira',
        url: 'https://company.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      })
    ).toEqual({
      key: 'ORCA-123',
      title: 'Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123'
    })
    expect(
      jiraIssueLinkFromLegacyWorkItem({
        provider: 'gitlab',
        type: 'mr',
        number: 42,
        title: 'Review',
        url: 'https://gitlab.example.com/group/repo/-/merge_requests/42'
      })
    ).toBeNull()
  })

  it('prefers an explicit link and treats explicit null as an unlink', () => {
    const legacy = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Legacy',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    expect(
      resolveJiraIssueLink({
        linkedJiraIssue: {
          key: 'ORCA-456',
          title: 'Dedicated',
          url: 'https://company.atlassian.net/browse/ORCA-456'
        },
        linkedWorkItem: legacy
      })?.key
    ).toBe('ORCA-456')
    expect(resolveJiraIssueLink({ linkedJiraIssue: null, linkedWorkItem: legacy })).toBeNull()
  })

  it('falls back to legacy metadata when the dedicated link is unreadable', () => {
    const legacy = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Legacy',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const corrupt = { key: 'ORCA-123', title: 'Corrupt', url: 'not-a-url' } as never

    expect(resolveJiraIssueLink({ linkedJiraIssue: corrupt, linkedWorkItem: legacy })?.key).toBe(
      'ORCA-123'
    )
    expect(
      resolveJiraIssueSourceContext({
        linkedJiraIssue: corrupt,
        linkedJiraIssueSourceContext: null,
        linkedWorkItem: legacy,
        linkedTaskSourceContext: sourceContext
      })
    ).toEqual(sourceContext)
    // An unreadable dedicated link with nothing behind it is still no link.
    expect(resolveJiraIssueLink({ linkedJiraIssue: corrupt })).toBeNull()
  })

  it('keeps a key-only link usable when the issue has no summary', () => {
    expect(
      normalizeJiraIssueLink({
        key: 'ORCA-123',
        title: '   ',
        url: 'https://company.atlassian.net/browse/ORCA-123'
      })
    ).toEqual({
      key: 'ORCA-123',
      title: 'ORCA-123',
      url: 'https://company.atlassian.net/browse/ORCA-123'
    })
  })

  it('matches Jira source context by site and project', () => {
    const issue = {
      key: 'ORCA-123',
      title: 'Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123'
    }
    expect(isJiraIssueLinkSourceContextMatch(issue, sourceContext)).toBe(true)
    expect(
      isJiraIssueLinkSourceContextMatch(issue, {
        ...sourceContext,
        providerIdentity: { ...sourceContext.providerIdentity, projectKey: 'OTHER' }
      })
    ).toBe(false)
  })
})
