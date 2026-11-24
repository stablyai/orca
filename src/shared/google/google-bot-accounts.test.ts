import { describe, expect, it } from 'vitest'
import {
  botDefaultGoogleAccount,
  botGoogleAccess,
  botGoogleDefault,
  botMayUseGoogleAccount,
  googleAccountNotAllowed
} from './google-bot-accounts'

describe('a bot’s Google accounts', () => {
  it('reads Google on with no list (saved before accounts could be chosen) as every account', () => {
    const access = botGoogleAccess({ google: true })
    expect(access).toEqual({ kind: 'all' })
    expect(botMayUseGoogleAccount(access, 'signed-in-later@example.com')).toBe(true)
    expect(botDefaultGoogleAccount(access, 'Me@Work.com')).toBe('me@work.com')
  })

  it('limits a listed bot to its accounts, case-insensitively, and nothing while off', () => {
    const access = botGoogleAccess({ google: true, googleAccounts: ['me@gmail.com'] })
    expect(botMayUseGoogleAccount(access, 'ME@gmail.com')).toBe(true)
    expect(botMayUseGoogleAccount(access, 'me@work.com')).toBe(false)
    const off = botGoogleAccess({ google: false, googleAccounts: ['me@gmail.com'] })
    expect(botMayUseGoogleAccount(off, 'me@gmail.com')).toBe(false)
    expect(botDefaultGoogleAccount(off, 'me@gmail.com')).toBeNull()
  })

  it('defaults to the computer default when chosen, else the first chosen', () => {
    const access = botGoogleAccess({ google: true, googleAccounts: ['b@x.com', 'a@x.com'] })
    expect(botDefaultGoogleAccount(access, 'a@x.com')).toBe('a@x.com')
    expect(botDefaultGoogleAccount(access, 'other@x.com')).toBe('b@x.com')
    expect(botDefaultGoogleAccount(access, null)).toBe('b@x.com')
  })

  it('keeps an unreadable default unreadable unless the bot has a single account', () => {
    const unreadable = { unreadable: 'Keychain denied.' }
    expect(botGoogleDefault(botGoogleAccess({ google: true }), unreadable)).toEqual(unreadable)
    const two = botGoogleAccess({ google: true, googleAccounts: ['a@x.com', 'b@x.com'] })
    expect(botGoogleDefault(two, unreadable)).toEqual(unreadable)
    const one = botGoogleAccess({ google: true, googleAccounts: ['A@x.com'] })
    expect(botGoogleDefault(one, unreadable)).toEqual({ email: 'a@x.com' })
  })

  it('says plainly when no account is chosen', () => {
    const none = botGoogleAccess({ google: true, googleAccounts: [] })
    if (none.kind !== 'some') {
      throw new Error('expected a list')
    }
    expect(googleAccountNotAllowed('Scout', 'me@work.com', none)).toBe(
      "Scout can't use me@work.com: no Google accounts are chosen for Scout. Ask your owner to choose one in Orca."
    )
  })
})
