import { describe, expect, it } from 'vitest'
import type { JiraIssue, JiraSite } from './jira-types'
import { getMatchingJiraSites, isResolvedJiraIssueMatch, parseJiraIssueUrl } from './jira-issue-url'

function site(id: string, siteUrl: string): JiraSite {
  return { id, siteUrl, email: `${id}@example.com`, displayName: id, accountId: id }
}

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '100',
    key: 'ORCA-123',
    siteId: 'cloud',
    title: 'Link Jira',
    url: 'https://company.atlassian.net/browse/ORCA-123',
    project: { id: '10', key: 'ORCA', name: 'Orca' },
    issueType: { id: '1', name: 'Task' },
    status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-07-27T00:00:00.000Z',
    createdAt: '2026-07-27T00:00:00.000Z',
    ...overrides
  }
}

describe('parseJiraIssueUrl', () => {
  it.each([
    [
      'https://company.atlassian.net/browse/orca-123?focusedCommentId=1#comment',
      { issueKey: 'ORCA-123', origin: 'https://company.atlassian.net', sitePath: '' }
    ],
    [
      'http://jira.company.com:8080/jira/browse/TEAM_CORE-42',
      {
        issueKey: 'TEAM_CORE-42',
        origin: 'http://jira.company.com:8080',
        sitePath: '/jira'
      }
    ],
    [
      ' HTTPS://JIRA.COMPANY.COM/jira/browse/Team9-7?foo=bar#details ',
      {
        issueKey: 'TEAM9-7',
        origin: 'https://jira.company.com',
        sitePath: '/jira'
      }
    ]
  ])('parses %s', (value, expected) => {
    expect(parseJiraIssueUrl(value)).toEqual(expected)
  })

  it.each([
    'ORCA-123',
    '/browse/ORCA-123',
    'ftp://jira.example.com/browse/ORCA-123',
    'https://user:secret@jira.example.com/browse/ORCA-123',
    'https://jira.example.com/browse/123',
    'https://jira.example.com/browse/-123',
    'https://jira.example.com/browse/ORCA_123',
    'https://jira.example.com/browse/ORCA-X',
    'https://jira.example.com/browse/ORCA-123/extra',
    'https://jira.example.com/browse/ORCA-123/'
  ])('rejects %s', (value) => {
    expect(parseJiraIssueUrl(value)).toBeNull()
  })
})

describe('Jira site and issue matching', () => {
  it('matches the complete origin and base path while retaining duplicate accounts', () => {
    const parsed = parseJiraIssueUrl('https://jira.company.com:8443/jira/browse/ORCA-123')!
    const matches = getMatchingJiraSites(parsed, [
      site('a', 'https://jira.company.com:8443/jira'),
      site('b', 'https://jira.company.com:8443/jira/'),
      site('lookalike', 'https://jira.company.com:8443/jira2'),
      site('port', 'https://jira.company.com/jira'),
      site('query', 'https://jira.company.com:8443/jira?account=a')
    ])
    expect(matches.map((candidate) => candidate.id)).toEqual(['a', 'b'])
  })

  it('requires the key, site id, and canonical URL site to agree', () => {
    const parsed = parseJiraIssueUrl('https://company.atlassian.net/browse/ORCA-123')!
    const connectedSite = site('cloud', 'https://company.atlassian.net')
    expect(isResolvedJiraIssueMatch(parsed, connectedSite, issue())).toBe(true)
    expect(isResolvedJiraIssueMatch(parsed, connectedSite, issue({ key: 'ORCA-124' }))).toBe(false)
    expect(isResolvedJiraIssueMatch(parsed, connectedSite, issue({ siteId: 'other' }))).toBe(false)
    expect(
      isResolvedJiraIssueMatch(
        parsed,
        connectedSite,
        issue({ url: 'https://other.atlassian.net/browse/ORCA-123' })
      )
    ).toBe(false)
  })
})
