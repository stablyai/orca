import { expect, it } from 'vitest'
import type { BotAutomationFacts } from '../bots/bot-automation-rows'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import { automationReceiptFacts } from './automation-receipt-facts'
import { automationReceiptStarts } from './automation-receipt-summary'

const automation: BotAutomationFacts = {
  id: 'a',
  name: 'Wait',
  enabled: true,
  nextRunAt: 0,
  updatedAt: 20,
  workspaceId: null,
  ...EVENT_ONLY_SCHEDULE,
  once: { by: 5000 }
}

it('distinguishes a proved deadline-only wait from legacy, partial and shortened alternatives', () => {
  const complete = automationReceiptFacts({ createdAt: 10 })
  expect(automationReceiptStarts(automation, complete)).toEqual([{ kind: 'deadline', at: 5000 }])
  expect(automationReceiptStarts(automation, undefined)).toEqual([
    { kind: 'unknown' },
    { kind: 'deadline', at: 5000 }
  ])
  expect(automationReceiptStarts(automation, complete, true)).toEqual([
    { kind: 'unknown' },
    { kind: 'deadline', at: 5000 }
  ])
  expect(
    automationReceiptStarts(automation, {
      version: 1,
      automationCreatedAt: 10,
      zone: { kind: 'not-recorded' },
      triggerExtras: { coverage: 'partial', items: [] }
    })
  ).toEqual([{ kind: 'unknown' }, { kind: 'deadline', at: 5000 }])
})

it('keeps custom cron and unknown recurrence zone literal, rather than inventing a preset', () => {
  expect(
    automationReceiptStarts(
      { ...automation, once: undefined, dtstart: 0, rrule: '0 */6 * * *' },
      undefined
    )
  ).toEqual([
    { kind: 'schedule', schedule: { kind: 'custom', expression: '0 */6 * * *' }, zone: null }
  ])
})

it('matches Google extra identity and kind before using its lead time', () => {
  const saved = {
    ...automation,
    on: [{ id: 'c', source: 'calendar' as const, event: 'starting_soon' as const }]
  }
  expect(
    automationReceiptStarts(
      saved,
      automationReceiptFacts({
        createdAt: 10,
        on: [{ id: 'other', source: 'calendar', event: 'starting_soon', minutesBefore: 60 }]
      })
    )[0]
  ).toEqual({
    kind: 'event',
    trigger: { id: 'c', source: 'calendar', event: 'starting_soon' },
    extra: null
  })
})
