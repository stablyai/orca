import { expect, it } from 'vitest'
import { makeTestBot } from '../../main/bots/bot.test-fixture'
import { normalizePersistedBots } from '../bot-types'

it('loads every bot and keeps the first spelling of case-only duplicate tags', () => {
  const loaded = normalizePersistedBots([
    { ...makeTestBot(), tags: 'malformed' },
    makeTestBot({ id: 'bot-2', tags: ['Billing', 'BILLING', 'Ops'] })
  ])
  expect(loaded.map((bot) => bot.tags)).toEqual([undefined, ['Billing', 'Ops']])
})
