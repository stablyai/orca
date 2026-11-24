import { describe, expect, it } from 'vitest'
import {
  BOT_MAX_SHARES,
  BOT_SHARES_FULL,
  BotSharesSchema,
  withBotShareInvites,
  withBotShareResolved,
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

  it('reads a saved list entry by entry, dropping only what it cannot read', () => {
    expect(BotSharesSchema.parse([invite, { kind: 'team', shareId: 'c' }])).toEqual([invite])
  })
})
