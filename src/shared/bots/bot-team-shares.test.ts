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
import {
  automationActsFor,
  botHome,
  botHomeName,
  botSharePersonName,
  withBotHome
} from './bot-home-of'

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

// An agent's file as an Orca before per-person Homes wrote it: no Home pointer on any share.
const OLD_BOT_FILE = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'owner-home',
  shares: [
    {
      kind: 'account',
      shareId: 'share-alice',
      accountId: 'acct-alice',
      name: 'Alice',
      email: 'alice@example.com',
      addedAt: 1,
      acceptedAt: 2
    }
  ],
  createdAt: 1,
  updatedAt: 1
}
const ALICE = { accountId: 'acct-alice' }

describe('a Home Chat for each person, as the bot file keeps them', () => {
  it('reads an older bot file unchanged: the owner’s Home where it was, no teammate Home yet', () => {
    const bot = BotSchema.parse(OLD_BOT_FILE)
    expect(bot.chatSessionId).toBe('owner-home')
    expect(botHome(bot, 'owner')).toBe('owner-home')
    expect(botHome(bot, ALICE)).toBeNull()
    expect(bot.shares).toEqual(OLD_BOT_FILE.shares)
  })

  it('keeps a teammate’s Home pointer through a save and read', () => {
    const bot = BotSchema.parse(OLD_BOT_FILE)
    const saved = { ...bot, ...withBotHome(bot, ALICE, 'alice-home') }
    const read = BotSchema.parse(JSON.parse(JSON.stringify(saved)))
    expect(botHome(read, ALICE)).toBe('alice-home')
    expect(read.chatSessionId).toBe('owner-home')
  })

  it('never writes a Home for a removed or declined share, leaving the list as it was', () => {
    const bot = BotSchema.parse(OLD_BOT_FILE)
    const removed = { ...bot, shares: [] }
    expect(() => withBotHome(removed, ALICE, 'alice-home')).toThrow('bot_not_shared')
    expect(removed.shares).toEqual([])
    const declined = BotSchema.parse({
      ...OLD_BOT_FILE,
      shares: [{ ...OLD_BOT_FILE.shares[0], acceptedAt: undefined, declinedAt: 3 }]
    })
    expect(() => withBotHome(declined, ALICE, 'alice-home')).toThrow('bot_not_shared')
    expect(botHome({ ...declined, ...withBotHome(declined, 'owner', 'x') }, ALICE)).toBeNull()
  })

  it('an automation saved before stamping acts for the owner; a stamped one never does', () => {
    const bot = BotSchema.parse(OLD_BOT_FILE)
    expect(automationActsFor(bot, {})).toEqual([{ kind: 'owner' }])
    // Removed since: still that member, by id alone, never the owner.
    expect(automationActsFor({ shares: [] }, { home: 'acct-alice' })).toEqual([
      { kind: 'person', source: 'orca', userId: 'acct-alice', workspaceId: null, role: 'member' }
    ])
  })
})

describe('a teammate share stored before names', () => {
  it('reads by its email until a repeat resolve names it; a repeat never clears or rewrites', () => {
    // A row an older build wrote: an account share with no name.
    const stored = BotSharesSchema.parse([
      {
        kind: 'account',
        shareId: 'a',
        accountId: 'acct-alice',
        email: 'alice@example.com',
        addedAt: 1
      }
    ])
    expect(botSharePersonName({ shares: stored }, 'acct-alice')).toBe('alice@example.com')
    expect(botHomeName({ shares: stored }, { accountId: 'acct-alice' })).toBe(
      'alice@example.com’s Home'
    )

    const again = { shareId: 'a', email: 'alice@example.com', accountId: 'acct-alice' }
    expect(withBotShareResolved(stored, again)).toBe(stored)
    expect(
      withBotShareResolved(stored, { ...again, accountId: 'acct-bob', name: 'Bob' })
    ).toBeNull()

    const named = withBotShareResolved(stored, { ...again, name: 'Alice Kim' })!
    expect(botHomeName({ shares: [...named] }, { accountId: 'acct-alice' })).toBe(
      'Alice Kim’s Home'
    )
    expect(withBotShareResolved(named, { ...again, name: 'Alice Kim' })).toBe(named)
    expect(withBotShareResolved(named, again)).toBe(named)
    // The teammate's sign-in email changed since they accepted: still their share, by account.
    const moved = withBotShareResolved(named, {
      ...again,
      email: 'alice@new.example',
      name: 'Alice K'
    })
    expect(botSharePersonName({ shares: [...moved!] }, 'acct-alice')).toBe('Alice K')
    expect(BotSharesSchema.parse(JSON.parse(JSON.stringify(named)))).toEqual(named)
  })
})
