import { expect, it } from 'vitest'
import { BotSchema } from '../bot-types'
import { BotUpdate, applyBotUpdates } from '../rpc-contract/bots-params'
import { BotLookAroundSet } from '../rpc-contract/bots-look-around-params'
import { botForLookAround } from './bot-look-around'

it('round-trips an independent look launch without changing the bot or its schedule', () => {
  const bot = BotSchema.parse({
    id: 'bot-1',
    name: 'Hermes',
    hostId: 'local',
    folder: 'hermes',
    folderWorkspaceId: 'home-1',
    agent: 'claude',
    avatar: null,
    paused: false,
    launch: { model: 'opus', options: { effort: 'high' } },
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    createdAt: 1,
    updatedAt: 1,
    lookAround: {
      on: false,
      every: 'twice-daily',
      weekdaysOnly: false,
      focus: 'My PRs',
      since: 123
    }
  })
  const request = BotLookAroundSet.parse({
    botId: bot.id,
    agentSetup: { agent: 'codex', launch: { model: 'gpt-6.2-sol', options: { effort: 'medium' } } }
  })
  const patch = BotUpdate.parse({
    botId: bot.id,
    updates: { lookAround: { agentSetup: request.agentSetup } }
  })
  const saved = BotSchema.parse(JSON.parse(JSON.stringify(applyBotUpdates(bot, patch.updates))))
  expect(saved).toEqual({
    ...bot,
    lookAround: {
      ...bot.lookAround,
      agentSetup: {
        agent: 'codex',
        launch: { model: 'gpt-6.2-sol', options: { effort: 'medium' } }
      }
    }
  })
  expect(botForLookAround(saved)).toEqual({
    ...saved,
    agent: 'codex',
    launch: { model: 'gpt-6.2-sol', options: { effort: 'medium' } }
  })
  const edited = applyBotUpdates(saved, { lookAround: { focus: 'My issues' } })
  expect(edited.lookAround?.agentSetup).toEqual({
    agent: 'codex',
    launch: { model: 'gpt-6.2-sol', options: { effort: 'medium' } }
  })
  const cleared = BotSchema.parse(
    JSON.parse(
      JSON.stringify(
        applyBotUpdates(
          saved,
          BotUpdate.parse({ botId: bot.id, updates: { lookAround: { agentSetup: null } } }).updates
        )
      )
    )
  )
  expect(cleared).toEqual(bot)
  expect(botForLookAround(cleared)).toEqual(bot)
  const agentOnly = applyBotUpdates(
    bot,
    BotUpdate.parse({ botId: bot.id, updates: { lookAround: { agentSetup: { agent: 'codex' } } } })
      .updates
  )
  expect(botForLookAround(agentOnly)).toEqual({
    ...agentOnly,
    agent: 'codex',
    launch: undefined
  })
  const degraded = BotSchema.parse({
    ...bot,
    lookAround: { ...bot.lookAround, agentSetup: { agent: 'hermes' } }
  })
  expect(degraded.lookAround?.agentSetup).toBeUndefined()
  expect(BotLookAroundSet.safeParse({ agentSetup: { agent: 'hermes' } }).success).toBe(false)
})
