import { describe, expect, it } from 'vitest'
import type { GoogleAccountView } from '../../../../shared/google/google-connect-types'
import { googleOfferFace } from './google-offer-face'

const account = (email: string, status: GoogleAccountView['status'] = 'connected') => ({
  email,
  status,
  services: [],
  connectedAt: 1
})
const client = { clientId: 'id', source: 'imported' as const, savedAt: 1 }

describe('the Google Connect card', () => {
  it('shows one Connect with no account here, or from a host too old to keep a default', () => {
    expect(googleOfferFace({ client, accounts: [], defaultAccount: null }, false)).toEqual({
      kind: 'connect'
    })
    expect(googleOfferFace({ client: null, accounts: [] }, false)).toEqual({ kind: 'connect' })
    expect(googleOfferFace({ client, accounts: [account('a@x.com')] }, false)).toEqual({
      kind: 'connect'
    })
  })

  it('offers the default or another account when one is here', () => {
    const google = {
      client,
      accounts: [account('a@x.com'), account('b@x.com')],
      defaultAccount: 'b@x.com'
    }
    expect(googleOfferFace(google, false)).toEqual({
      kind: 'choose',
      defaultAccount: 'b@x.com',
      reconnect: false
    })
  })

  it('reconnects a signed-out default instead of using it', () => {
    const google = {
      client,
      accounts: [account('a@x.com', 'reconnect'), account('b@x.com')],
      defaultAccount: 'a@x.com'
    }
    expect(googleOfferFace(google, false)).toEqual({
      kind: 'choose',
      defaultAccount: 'a@x.com',
      reconnect: true
    })
  })

  it('reads Connected once on, adding an account only where the host keeps a default', () => {
    const accounts = [account('a@x.com')]
    expect(googleOfferFace({ client, accounts, defaultAccount: 'a@x.com' }, true)).toEqual({
      kind: 'connected',
      defaultAccount: 'a@x.com',
      canAdd: true
    })
    expect(googleOfferFace({ client, accounts }, true)).toEqual({
      kind: 'connected',
      defaultAccount: null,
      canAdd: false
    })
  })
})
