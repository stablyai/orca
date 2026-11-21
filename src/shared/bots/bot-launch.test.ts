import { describe, expect, it } from 'vitest'
import { BotSchema } from '../bot-types'
import { BotCreate } from '../rpc-contract/bots-params'
import { botLaunchFromChoices, botLaunchWithPicks } from './bot-launch'
import { makeTestBot } from '../../main/bots/bot.test-fixture'

describe('a bot launch', () => {
  it('never saves a value a chat would refuse, and a saved bad one reads as unset', () => {
    const bad = { model: 'opus', options: { fastMode: 'yes' } }

    expect(BotCreate.safeParse({ name: 'Reviewer', launch: bad }).success).toBe(false)
    const read = BotSchema.parse({ ...makeTestBot(), launch: bad })
    expect(read.id).toBe('bot-1')
    expect(read.launch).toBeUndefined()
  })

  it("keeps only the picker's seedable choices, and nothing when none were made", () => {
    expect(
      botLaunchFromChoices({
        model: 'opus',
        options: { effort: 'high', fastMode: 'true', personality: 'calm' }
      })
    ).toEqual({ model: 'opus', options: { effort: 'high', fastMode: 'true' } })
    expect(botLaunchFromChoices({ options: {} })).toBeUndefined()
  })
})

describe("a pick in a bot's conversation", () => {
  const pick = (optionId: string, value: string | boolean, modelId = 'claude-haiku-5-5') => ({
    modelId,
    optionId,
    value
  })

  it('becomes the bot model, starting that model with fresh options', () => {
    expect(
      botLaunchWithPicks({ model: 'claude-opus-5-5', options: { effort: 'max' } }, [
        pick('model', 'claude-haiku-5-5'),
        pick('effort', 'high')
      ])
    ).toEqual({ model: 'claude-haiku-5-5', options: { effort: 'high' } })
  })

  it('keeps an option for the model the bot runs, encoded as the picker saves it', () => {
    expect(botLaunchWithPicks(undefined, [pick('fastMode', true)])).toEqual({
      model: 'claude-haiku-5-5',
      options: { fastMode: 'true' }
    })
  })

  it('never adopts a guessed CLI default as the bot model', () => {
    const launch = { model: 'claude-sonnet-5-5' }
    expect(
      botLaunchWithPicks(launch, [
        {
          ...pick('model', 'claude-opus-5-5'),
          adoptModelAsLaunchDefault: false
        }
      ])
    ).toEqual(launch)
  })
})
