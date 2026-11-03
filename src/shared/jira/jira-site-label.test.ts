import { describe, expect, it } from 'vitest'
import { getJiraSiteLabel, withJiraSiteLabel } from './jira-site-label'

describe('getJiraSiteLabel', () => {
  it('tells apart sites connected with the same profile name', () => {
    const labels = [
      { displayName: 'Ada Lovelace', siteUrl: 'https://acme.atlassian.net' },
      { displayName: 'Ada Lovelace', siteUrl: 'https://globex.atlassian.net' }
    ].map(getJiraSiteLabel)
    expect(labels).toEqual([
      'Ada Lovelace (acme.atlassian.net)',
      'Ada Lovelace (globex.atlassian.net)'
    ])
  })

  it('keeps the Server/DC context path that separates sites on one host', () => {
    expect(
      getJiraSiteLabel({ displayName: 'Ada', siteUrl: 'https://jira.example.com/jira/' })
    ).toBe('Ada (jira.example.com/jira)')
  })

  it('falls back to the host when the name is blank or repeats it', () => {
    expect(getJiraSiteLabel({ displayName: '  ', siteUrl: 'https://a.atlassian.net' })).toBe(
      'a.atlassian.net'
    )
    expect(
      getJiraSiteLabel({ displayName: 'a.atlassian.net', siteUrl: 'https://a.atlassian.net' })
    ).toBe('a.atlassian.net')
  })
})

describe('withJiraSiteLabel', () => {
  const sites = [
    { id: 'acme', displayName: 'Ada Lovelace', siteUrl: 'https://acme.atlassian.net' },
    { id: 'globex', displayName: 'Ada Lovelace', siteUrl: 'https://globex.atlassian.net' }
  ]

  it('relabels name-only site names from older remote hosts', () => {
    const issues = [
      { key: 'A-1', siteId: 'acme', siteName: 'Ada Lovelace' },
      { key: 'G-1', siteId: 'globex', siteName: 'Ada Lovelace' }
    ].map((issue) => withJiraSiteLabel(issue, sites))
    expect(issues.map((issue) => issue.siteName)).toEqual([
      'Ada Lovelace (acme.atlassian.net)',
      'Ada Lovelace (globex.atlassian.net)'
    ])
  })

  it('returns the same issue when it is already labeled or its site is unknown', () => {
    const labeled = { key: 'A-1', siteId: 'acme', siteName: 'Ada Lovelace (acme.atlassian.net)' }
    const unknown = { key: 'X-1', siteId: 'gone', siteName: 'Old site' }
    const noSite = { key: 'N-1', siteName: 'Ada Lovelace' }
    expect(withJiraSiteLabel(labeled, sites)).toBe(labeled)
    expect(withJiraSiteLabel(unknown, sites)).toBe(unknown)
    expect(withJiraSiteLabel(noSite, sites)).toBe(noSite)
  })
})
