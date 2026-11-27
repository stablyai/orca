import { describe, expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { normalizePersistedBots } from '../bot-types'
import { BotUpdate } from '../rpc-contract/bots-params'
import { BotGroupMessageSchema } from './bot-group-schema'

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
