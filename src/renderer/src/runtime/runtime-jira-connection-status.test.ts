import { describe, expect, it } from 'vitest'
import { parseJiraConnectionStatus } from './runtime-jira-connection-status'

describe('parseJiraConnectionStatus', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a non-boolean connected', { connected: 'yes', viewer: null }],
    ['a non-object viewer', { connected: true, viewer: 'me' }],
    ['non-array sites', { connected: true, viewer: null, sites: {} }]
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

  it('fills a missing viewer with null', () => {
    expect(parseJiraConnectionStatus({ connected: false })).toEqual({
      connected: false,
      viewer: null
    })
  })
})
