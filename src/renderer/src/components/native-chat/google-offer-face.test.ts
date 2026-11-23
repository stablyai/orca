import { describe, expect, it } from 'vitest'
import type { GoogleAccountView } from '../../../../shared/google/google-connect-types'
import { googleOfferFace, googleOfferSignedInAnswer } from './google-offer-face'

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

  it('reconnects a signed-out default even when on for the bot and another account works', () => {
    const google = {
      client,
      accounts: [account('a@x.com', 'reconnect'), account('b@x.com')],
      defaultAccount: 'a@x.com'
    }
    expect(googleOfferFace(google, true)).toEqual({
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

describe('telling the chat which account the card signed in', () => {
  const card = { added: null, defaultAccount: 'work@x.com' }

  it('answers once for another account, and not for the default', () => {
    expect(googleOfferSignedInAnswer('me@x.com', card)).toBe('send')
    expect(googleOfferSignedInAnswer('work@x.com', card)).toBeNull()
  })

  it('answers again, without the spent claim, when an answered card adds one more', () => {
    const answered = { ...card, added: 'me@x.com' }
    expect(googleOfferSignedInAnswer('side@x.com', answered)).toBe('again')
    expect(googleOfferSignedInAnswer('work@x.com', answered)).toBe('again')
    expect(googleOfferSignedInAnswer('me@x.com', answered)).toBeNull()
  })
})
