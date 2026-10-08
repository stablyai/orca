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

  it('keeps a well-formed status', () => {
    const status = {
      connected: true,
      viewer: { accountId: 'a', email: 'a@example.com', displayName: 'A' },
      sites: [],
      activeSiteId: 'site-1',
      credentialProtection: 'plaintext'
    }
    expect(parseJiraConnectionStatus(status)).toEqual(status)
  })

  it('round-trips a populated multi-site status unchanged', () => {
    const status = {
      connected: true,
      viewer: {
        accountId: 'account-cloud',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        avatarUrl: 'https://avatar.example/ada.png'
      },
      sites: [
        {
          id: 'site-server',
          siteUrl: 'https://jira.internal.example',
          email: '',
          displayName: 'Ada (PAT)',
          accountId: '',
          authType: 'server'
        },
        {
          id: 'site-cloud',
          siteUrl: 'https://example.atlassian.net',
          email: 'ada@example.com',
          displayName: 'Ada Lovelace',
          accountId: 'account-cloud',
          authType: 'cloud'
        },
        {
          id: 'site-legacy',
          siteUrl: 'https://legacy.atlassian.net',
          email: 'ada@legacy.example',
          displayName: 'Ada (legacy)',
          accountId: 'account-legacy'
        }
      ],
      activeSiteId: 'site-cloud',
      selectedSiteId: 'all',
      credentialError: 'Could not decrypt the stored Jira token.',
      credentialProtection: 'plaintext'
    }
    expect(parseJiraConnectionStatus(status)).toEqual(status)
  })

  it.each([
    ['a non-object viewer', { connected: true, viewer: 'me' }],
    ['a non-array sites value', { connected: true, viewer: null, sites: {} }]
  ])('keeps a connected status with %s', (_label, value) => {
    expect(parseJiraConnectionStatus(value)).toEqual({ connected: true, viewer: null })
  })

  it('fills a missing viewer with null', () => {
    expect(parseJiraConnectionStatus({ connected: false })).toEqual({
      connected: false,
      viewer: null
    })
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

  it('keeps a site with an unknown auth type connected', () => {
    expect(
      parseJiraConnectionStatus({
        connected: true,
        viewer: null,
        sites: [
          {
            id: 'site-1',
            siteUrl: 'https://example.atlassian.net',
            email: 'a@example.com',
            displayName: 'Example',
            accountId: 'account-1',
            authType: 'datacenter'
          }
        ]
      })
    ).toEqual({
      connected: true,
      viewer: null,
      sites: [
        {
          id: 'site-1',
          siteUrl: 'https://example.atlassian.net',
          email: 'a@example.com',
          displayName: 'Example',
          accountId: 'account-1'
        }
      ]
    })
  })
})
