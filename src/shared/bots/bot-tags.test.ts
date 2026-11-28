import { expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { normalizePersistedBots } from '../bot-types'
import { applyBotUpdates, BotUpdate } from '../rpc-contract/bots-params'
import { limitBotTagDraft } from './bot-tags'

it('loads every bot and keeps the first spelling of case-only duplicate tags', () => {
  const loaded = normalizePersistedBots([
    { ...makeTestBot(), tags: 'malformed' },
    makeTestBot({ id: 'bot-2', tags: ['Billing', 'BILLING', 'Ops'] })
  ])
  expect(loaded.map((bot) => bot.tags)).toEqual([undefined, ['Billing', 'Ops']])
})

it('preserves independent tag edits and the first spelling of each tag', () => {
  let bot = makeTestBot({ tags: ['Shared'] })
  const edit = (tags: unknown): void => {
    const { updates } = BotUpdate.parse({ botId: bot.id, updates: { tags } })
    bot = applyBotUpdates(bot, updates)
  }

  edit({ add: ['UI'] })
  edit({ add: ['Ops', 'ui'] })
  expect(bot.tags).toEqual(['Shared', 'UI', 'Ops'])
  edit({ remove: 'shared' })
  expect(bot.tags).toEqual(['UI', 'Ops'])
})

it('takes overflow from the inserted text and preserves the text after the caret', () => {
  const suffix = `${'😀'.repeat(29)}Z`
  expect(limitBotTagDraft(`aXYZ${suffix}`, 4)).toBe(`aX${suffix}`)
})
