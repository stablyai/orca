import { describe, expect, it } from 'vitest'
import type { BotDiscordView } from '@/lib/bot-discord-state'
import { botDiscordSetupStep } from './discord-setup-step'

const acme = { guildId: '900', name: 'Acme' }
const beta = { guildId: '901', name: 'Beta' }

function ready(...guilds: { guildId: string; name: string }[]): BotDiscordView {
  return {
    status: 'ready',
    discord: {
      bots: [
        {
          botId: 'b1',
          state: 'ready',
          applicationId: '5',
          botUserId: '6',
          botName: 'Triage',
          guilds
        }
      ]
    }
  }
}

const fresh = { newToken: false, known: null, target: null }

describe('botDiscordSetupStep', () => {
  it('asks for a token while the bot has none, or its token was revoked', () => {
    expect(botDiscordSetupStep({ status: 'ready', discord: { bots: [] } }, 'b1', fresh)).toEqual({
      kind: 'token',
      broken: null
    })
    const revoked: BotDiscordView = {
      status: 'ready',
      discord: {
        bots: [{ botId: 'b1', state: 'broken', applicationId: '5', reason: 'token_revoked' }]
      }
    }
    expect(botDiscordSetupStep(revoked, 'b1', fresh)).toEqual({
      kind: 'token',
      broken: 'token_revoked'
    })
  })

  it('waits on the invite until the bot joins a server it was not in when setup began', () => {
    expect(botDiscordSetupStep(ready(acme), 'b1', { ...fresh, known: ['900'] })).toEqual({
      kind: 'invite',
      applicationId: '5',
      botName: 'Triage'
    })
    expect(botDiscordSetupStep(ready(acme, beta), 'b1', { ...fresh, known: ['900'] })).toEqual({
      kind: 'done',
      guilds: [beta],
      botName: 'Triage'
    })
  })

  it('finishes a repair once the row’s server is reachable again', () => {
    expect(
      botDiscordSetupStep(ready(acme), 'b1', { ...fresh, known: ['900'], target: '900' })
    ).toEqual({ kind: 'done', guilds: [acme], botName: 'Triage' })
  })
})
