import { describe, expect, it } from 'vitest'
import { getJiraSiteLabel } from './jira-site-label'

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
