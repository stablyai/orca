import { describe, expect, it } from 'vitest'
import { parseJiraConnectionStatus } from './runtime-jira-connection-status'

describe('parseJiraConnectionStatus', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a non-boolean connected', { connected: 'yes', viewer: null }]
  ])('reads %s as disconnected', (_label, value) => {
    expect(parseJiraConnectionStatus(value)).toEqual({ connected: false, viewer: null })
  })

  it('keeps a connected status while dropping malformed nested values', () => {
    expect(
      parseJiraConnectionStatus({
        connected: true,
        viewer: {},
        sites: [
          {
            id: 'site-1',
            siteUrl: 'https://example.atlassian.net',
            email: null,
            displayName: 'Example',
            accountId: 'account-1'
          },
          null
        ],
        activeSiteId: 1,
        selectedSiteId: 'site-1',
        credentialError: { message: 'nope' },
        credentialProtection: 'future-value'
      })
    ).toEqual({
      connected: true,
      viewer: null,
      sites: [
        {
          id: 'site-1',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          displayName: 'Example',
          accountId: 'account-1'
        }
      ],
      selectedSiteId: 'site-1'
    })
  })
})
