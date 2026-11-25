import { describe, expect, it } from 'vitest'
import { OWNER_ACTS_FOR, opensHostTab, type BotRequestPerson } from './bot-acts-for'
import { botHomeActsFor } from './bot-home-of'

const TEAMMATE = { accountId: 'acct-teammate' }
const bot = {
  shares: [
    {
      kind: 'account' as const,
      shareId: 'share-1',
      accountId: TEAMMATE.accountId,
      name: 'Teammate',
      email: 'teammate@example.com',
      addedAt: 1,
      acceptedAt: 2
    }
  ]
}
const teammateNewChat: BotRequestPerson = {
  kind: 'person',
  source: 'orca',
  userId: TEAMMATE.accountId,
  name: 'Teammate',
  workspaceId: null,
  role: 'member'
}
const slackAsker: BotRequestPerson = {
  kind: 'person',
  source: 'slack',
  userId: 'U1',
  workspaceId: 'T1',
  role: 'member'
}

describe('opensHostTab', () => {
  it('opens no host tab for a chat a teammate started: their new chat or their Home', () => {
    expect(opensHostTab([teammateNewChat])).toBe(false)
    expect(opensHostTab(botHomeActsFor(bot, TEAMMATE))).toBe(false)
  })

  it('opens one for the owner’s chats, unrecorded ones, and requests from people elsewhere', () => {
    expect(opensHostTab(botHomeActsFor(bot, 'owner'))).toBe(true)
    expect(opensHostTab([...OWNER_ACTS_FOR])).toBe(true)
    expect(opensHostTab(undefined)).toBe(true)
    expect(opensHostTab([])).toBe(true)
    expect(opensHostTab([slackAsker])).toBe(true)
    expect(opensHostTab([teammateNewChat, { kind: 'owner' }])).toBe(true)
  })
})
