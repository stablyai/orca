import { describe, expect, it } from 'vitest'
import {
  jiraIssueKeyPrefixes,
  linearIssueKeyPrefixes,
  mergeIssueKeyPrefixes
} from './native-chat-issue-keys'

const workspace = (id: string, organizationUrlKey?: string) => ({
  id,
  organizationId: `org-${id}`,
  organizationName: id,
  displayName: 'Ada',
  email: null,
  organizationUrlKey
})

const site = (id: string, siteUrl: string) => ({
  id,
  siteUrl,
  email: 'ada@example.com',
  displayName: 'Ada',
  accountId: 'a'
})

describe('linearIssueKeyPrefixes', () => {
  it('maps each team key to its workspace issue URL', () => {
    expect(
      linearIssueKeyPrefixes(
        [
          { id: '1', workspaceId: 'a', name: 'Engineering', key: 'ENG' },
          { id: '2', workspaceId: 'b', name: 'Design', key: 'DES' }
        ],
        [workspace('a', 'acme'), workspace('b', 'globex')]
      )
    ).toEqual([
      ['ENG', 'https://linear.app/acme/issue/'],
      ['DES', 'https://linear.app/globex/issue/']
    ])
  })

  it("falls back to the team URL's organization when the workspace has no URL key", () => {
    expect(
      linearIssueKeyPrefixes(
        [{ id: '1', name: 'Ops', key: 'OPS', url: 'https://linear.app/acme/team/OPS/active' }],
        []
      )
    ).toEqual([['OPS', 'https://linear.app/acme/issue/']])
  })
})

describe('jiraIssueKeyPrefixes', () => {
  it("maps each project key to its site's browse URL", () => {
    expect(
      jiraIssueKeyPrefixes(
        [
          { id: '1', key: 'PROJ', name: 'Project', siteId: 's1' },
          { id: '2', key: 'SUP', name: 'Support', siteId: 's2' }
        ],
        [site('s1', 'https://acme.atlassian.net/'), site('s2', 'https://jira.globex.example')]
      )
    ).toEqual([
      ['PROJ', 'https://acme.atlassian.net/browse/'],
      ['SUP', 'https://jira.globex.example/browse/']
    ])
  })
})

describe('mergeIssueKeyPrefixes', () => {
  it('keeps the first tracker for a key two of them share', () => {
    const merged = mergeIssueKeyPrefixes(
      [['ENG', 'https://linear.app/acme/issue/']],
      [['ENG', 'https://acme.atlassian.net/browse/']]
    )
    expect(merged.get('ENG')).toBe('https://linear.app/acme/issue/')
  })
})
