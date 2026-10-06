import { describe, expect, it } from 'vitest'
import type { JiraConnectionStatus } from '../../../shared/jira-types'
import { getJiraSelfUser } from './jira-self-user'

const viewer = {
  accountId: 'viewer-1',
  displayName: 'Viewer One',
  email: 'viewer@example.com'
}

function status(partial: Partial<JiraConnectionStatus>): JiraConnectionStatus {
  return { connected: true, viewer, ...partial }
}

describe('getJiraSelfUser', () => {
  it('prefers the stored identity of the target site', () => {
    const result = getJiraSelfUser(
      status({
        activeSiteId: 'a',
        sites: [
          {
            id: 'a',
            siteUrl: 'https://a',
            email: 'a@example.com',
            displayName: 'User A',
            accountId: 'acc-a'
          },
          {
            id: 'b',
            siteUrl: 'https://b',
            email: 'b@example.com',
            displayName: 'User B',
            accountId: 'acc-b'
          }
        ]
      }),
      'b'
    )
    expect(result).toEqual({ accountId: 'acc-b', displayName: 'User B' })
  })

  it('does not fall back to the viewer for a different, unknown site', () => {
    const result = getJiraSelfUser(
      status({
        activeSiteId: 'a',
        sites: [
          {
            id: 'a',
            siteUrl: 'https://a',
            email: 'a@example.com',
            displayName: 'User A',
            accountId: 'acc-a'
          },
          { id: 'b', siteUrl: 'https://b', email: 'b@example.com', displayName: '', accountId: '' }
        ]
      }),
      'b'
    )
    expect(result).toBeNull()
  })

  it('falls back to the viewer for the active site and for siteless single-site setups', () => {
    const withActive = getJiraSelfUser(
      status({
        activeSiteId: 'a',
        sites: [
          { id: 'a', siteUrl: 'https://a', email: 'a@example.com', displayName: '', accountId: '' },
          {
            id: 'b',
            siteUrl: 'https://b',
            email: 'b@example.com',
            displayName: 'User B',
            accountId: 'acc-b'
          }
        ]
      }),
      'a'
    )
    expect(withActive?.accountId).toBe('viewer-1')

    const withoutSiteId = getJiraSelfUser(status({}), null)
    expect(withoutSiteId?.accountId).toBe('viewer-1')
  })

  it('never borrows the viewer for an explicitly unknown site', () => {
    expect(getJiraSelfUser(status({ activeSiteId: 'a' }), 'b')).toBeNull()
    expect(
      getJiraSelfUser(
        status({
          activeSiteId: 'a',
          sites: [{ id: 'a', siteUrl: 'https://a', email: '', displayName: '', accountId: '' }]
        }),
        'b'
      )
    ).toBeNull()
  })

  it('returns null when nothing is connected', () => {
    expect(getJiraSelfUser(null, 'a')).toBeNull()
    expect(getJiraSelfUser(status({ connected: false }), null)).toBeNull()
    expect(getJiraSelfUser({ connected: false, viewer: null }, null)).toBeNull()
  })
})
