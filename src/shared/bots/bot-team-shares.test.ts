import { describe, expect, it } from 'vitest'
import { BotSchema } from '../bot-types'
import {
  BOT_MAX_SHARES,
  BOT_SHARES_FULL,
  BotSharesSchema,
  withBotShareInvites,
  withBotShareResolved,
  withBotSharesEmailed,
  type BotShare
} from './bot-team-shares'

let next = 0
const mint = () => ({ shareId: `share-${++next}`, addedAt: 1 })

const invite: BotShare = { kind: 'invite', shareId: 'a', email: 'alice@example.com', addedAt: 1 }
const resolved = {
  shareId: 'a',
  email: 'Alice@Example.com ',
  accountId: 'acct-alice',
  name: 'Alice'
}

describe('bot share list', () => {
  it('adds each new email once, normalized, and refuses past the cap', () => {
    const shares = withBotShareInvites([invite], [' ALICE@example.com', 'Bob@Example.com'], mint)
    expect(shares.map((share) => share.email)).toEqual(['alice@example.com', 'bob@example.com'])
    const full = Array.from({ length: BOT_MAX_SHARES }, (_, index) => `p${index}@example.com`)
    expect(() => withBotShareInvites([invite], full, mint)).toThrow(BOT_SHARES_FULL)
  })

  it('resolves an invite to its account under the same share id, and a repeat writes nothing', () => {
    const once = withBotShareResolved([invite], resolved)
    expect(once).toEqual([
      {
        kind: 'account',
        shareId: 'a',
        accountId: 'acct-alice',
        name: 'Alice',
        email: 'alice@example.com',
        addedAt: 1
      }
    ])
    expect(withBotShareResolved(once!, resolved)).toBe(once)
  })

  it('never brings back a removed invite or resolves another email or account', () => {
    expect(withBotShareResolved([], resolved)).toBeNull()
    expect(withBotShareResolved([invite], { ...resolved, email: 'eve@example.com' })).toBeNull()
    const account = withBotShareResolved([invite], resolved)!
    expect(withBotShareResolved(account, { ...resolved, accountId: 'acct-eve' })).toBeNull()
  })

  it('drops an invite that resolves to an account already on the list', () => {
    const account: BotShare = { ...withBotShareResolved([invite], resolved)![0]!, shareId: 'b' }
    const second: BotShare = { ...invite, email: 'alice@work.example.com' }
    expect(withBotShareResolved([account, second], { ...resolved, email: second.email })).toEqual([
      account
    ])
  })

  it('keeps the services a resolve names; an old entry reads none, an unknown one drops, not the share', () => {
    const linked = withBotShareResolved([invite], {
      ...resolved,
      linkedSources: ['slack', 'linear']
    })!
    expect(linked[0]).toMatchObject({ kind: 'account', linkedSources: ['slack', 'linear'] })
    const [account] = withBotShareResolved([invite], resolved)!
    expect(BotSharesSchema.parse([account])[0]).not.toHaveProperty('linkedSources')
    const fromNewer = { ...account, linkedSources: ['discord', 'slack', 'github', 'slack'] }
    expect(BotSharesSchema.parse([fromNewer])).toEqual([
      { ...account, linkedSources: ['github', 'slack'] }
    ])
  })

  it("updates an account's linked sources from a resolve without email, only when they changed", () => {
    const once = withBotShareResolved([invite], { ...resolved, linkedSources: ['slack'] })!
    const later = { shareId: 'a', accountId: 'acct-alice' }
    expect(withBotShareResolved(once, { ...later, linkedSources: ['slack'] })).toBe(once)
    const relinked = withBotShareResolved(once, { ...later, linkedSources: ['github', 'slack'] })!
    expect(relinked[0]).toMatchObject({ linkedSources: ['github', 'slack'] })
    expect(withBotShareResolved(relinked, { ...later, linkedSources: [] })![0]).not.toHaveProperty(
      'linkedSources'
    )
    expect(withBotShareResolved(once, { ...later, accountId: 'acct-eve' })).toBeNull()
    // An invite resolves only by its email.
    expect(withBotShareResolved([invite], later)).toBeNull()
  })

  it('reads a saved list entry by entry, and a list that is not one as unset, never losing the bot', () => {
    expect(BotSharesSchema.parse([invite, { kind: 'team', shareId: 'c' }])).toEqual([invite])
    expect(BotSchema.shape.shares.parse(null)).toBeUndefined()
    expect(BotSchema.shape.shares.parse({ kind: 'invite' })).toBeUndefined()
  })

  it('keeps when an invite was emailed across a save, and marks only invites', () => {
    const account: BotShare = { ...withBotShareResolved([invite], resolved)![0]!, shareId: 'b' }
    const marked = withBotSharesEmailed([invite, account], new Set(['a', 'b']), 7)
    expect(marked).toEqual([{ ...invite, emailedAt: 7 }, account])
    expect(BotSharesSchema.parse(JSON.parse(JSON.stringify(marked)))).toEqual(marked)
  })
})
