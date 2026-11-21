import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../main/bots/bot.test-fixture'
import { gitHubMembersOf, normalizePersistedBots, withGitHubMembersTagged } from './bot-types'
import { applyBotUpdates, BotUpdate } from './rpc-contract/bots-params'
import { BotGroupMessageSchema } from './bots/bot-group-schema'

describe('GitHub people per org', () => {
  const alice = { id: '101', name: 'alice', source: 'github' }

  it('puts people saved before orgs had rows in each org the bot is in, never a later one', () => {
    const bot = makeTestBot({
      github: { removedInstallationIds: ['9'] },
      members: [alice, { id: 'U1', name: 'Ada' }]
    })
    const tagged = withGitHubMembersTagged(bot, ['7', '8', '9'])
    expect(tagged.members).toEqual([
      { ...alice, workspaceId: '7' },
      { ...alice, workspaceId: '8' },
      { id: 'U1', name: 'Ada' }
    ])
    // Once tagged, nothing changes again, and an org added later starts with nobody.
    expect(withGitHubMembersTagged(tagged, ['7', '8', '10'])).toBe(tagged)
    expect(gitHubMembersOf(tagged.members, '10')).toEqual([])
    // Orgs not known yet tag nobody.
    expect(withGitHubMembersTagged(bot, [])).toBe(bot)
  })

  it('removes a person from one org only', () => {
    const bot = withGitHubMembersTagged(makeTestBot({ github: {}, members: [alice] }), ['7', '8'])
    const after = applyBotUpdates(bot, {
      removeMember: { id: '101', source: 'github', workspaceId: '7' }
    })
    expect(gitHubMembersOf(after.members, '7')).toEqual([])
    expect(gitHubMembersOf(after.members, '8')).toEqual([{ ...alice, workspaceId: '8' }])
  })
})

describe('stored outfits', () => {
  it("keeps an outfit a newer version added through this version's load and save", () => {
    const saved = JSON.parse(JSON.stringify([makeTestBot({ avatarOutfit: 'aviator' })]))
    const [loaded] = normalizePersistedBots(saved)
    expect(loaded?.avatarOutfit).toBe('aviator')
    expect(JSON.parse(JSON.stringify(loaded)).avatarOutfit).toBe('aviator')
  })

  it("takes a newer client's outfit on an edit, and refuses an id that isn't one", () => {
    const edit = (avatarOutfit: string) =>
      BotUpdate.safeParse({ botId: 'b1', updates: { avatarOutfit } })
    expect(edit('aviator').success).toBe(true)
    expect(edit('Bad Id!').success).toBe(false)
  })

  it("keeps a group turn's outfit a newer version added", () => {
    const message = BotGroupMessageSchema.parse({
      id: 'm1',
      groupId: 'g1',
      sequence: 0,
      author: { kind: 'owner' },
      text: 'hi',
      createdAt: 0,
      turns: [
        {
          operationId: 'op1',
          botId: 'b1',
          botName: 'Perf',
          avatar: 'mascot:D1',
          avatarOutfit: 'aviator',
          agent: 'claude',
          sessionId: 's1'
        }
      ]
    })
    expect(message.turns[0]?.avatarOutfit).toBe('aviator')
  })
})
