import { expect, it } from 'vitest'
import type { BotAutomationFacts } from '../bots/bot-automation-rows'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import { automationReceiptFacts } from './automation-receipt-facts'
import {
  automationReceiptStartDetails,
  automationReceiptStarts
} from './automation-receipt-summary'

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

it('uses recorded evidence for retained deadline-only waits and keeps unknown-start fallbacks', () => {
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

it('keeps the historical schedule inspectable when the saved receipt was paused', () => {
  expect(
    automationReceiptStartDetails(
      { ...automation, enabled: false, once: undefined, dtstart: 0, rrule: '0 */6 * * *' },
      {
        version: 1,
        automationCreatedAt: 10,
        zone: { kind: 'effective-at-save', iana: 'UTC' },
        triggerExtras: { coverage: 'complete', items: [] }
      }
    )
  ).toEqual([
    {
      start: {
        kind: 'schedule',
        schedule: { kind: 'custom', expression: '0 */6 * * *' },
        zone: 'UTC'
      },
      showLabel: true
    }
  ])
})

it('associates each saved account and condition state with its historical start', () => {
  const details = automationReceiptStartDetails(
    {
      ...automation,
      once: undefined,
      on: [
        { id: 'personal', source: 'gmail', event: 'new_email' },
        { id: 'team', source: 'gmail', event: 'new_email' },
        { id: 'slack', source: 'slack', event: 'message' }
      ]
    },
    {
      version: 1,
      automationCreatedAt: 10,
      zone: { kind: 'not-recorded' },
      triggerExtras: {
        coverage: 'complete',
        items: [
          {
            triggerId: 'personal',
            additionalConditions: 'none',
            google: { kind: 'gmail', account: { kind: 'named', value: 'personal@example.test' } }
          },
          {
            triggerId: 'team',
            additionalConditions: 'present',
            google: { kind: 'gmail', account: { kind: 'named', value: 'team@example.test' } }
          },
          { triggerId: 'slack', additionalConditions: 'unknown' }
        ]
      }
    }
  )
  expect(
    details.map(({ start, showLabel }) =>
      start.kind === 'event'
        ? {
            id: start.trigger.id,
            account: start.extra?.google?.account,
            conditions: start.extra?.additionalConditions,
            showLabel
          }
        : start
    )
  ).toEqual([
    {
      id: 'personal',
      account: { kind: 'named', value: 'personal@example.test' },
      conditions: 'none',
      showLabel: true
    },
    {
      id: 'team',
      account: { kind: 'named', value: 'team@example.test' },
      conditions: 'present',
      showLabel: true
    },
    { id: 'slack', account: undefined, conditions: 'unknown', showLabel: true }
  ])
})

it('rejects the whole Google extra on a non-Google trigger, including its condition claim', () => {
  expect(
    automationReceiptStarts(
      { ...automation, once: undefined, on: [{ id: 's', source: 'slack', event: 'message' }] },
      {
        version: 1,
        automationCreatedAt: 10,
        zone: { kind: 'not-recorded' },
        triggerExtras: {
          coverage: 'complete',
          items: [
            {
              triggerId: 's',
              additionalConditions: 'none',
              google: { kind: 'gmail', account: { kind: 'named', value: 'unrelated@example.test' } }
            }
          ]
        }
      }
    )
  ).toEqual([
    { kind: 'event', trigger: { id: 's', source: 'slack', event: 'message' }, extra: null }
  ])
})

it('labels two retained historical events so their conditions remain attributable', () => {
  expect(
    automationReceiptStartDetails(
      {
        ...automation,
        once: undefined,
        on: [
          { id: 's', source: 'slack', event: 'message' },
          { id: 'g', source: 'github', event: 'comment' }
        ]
      },
      undefined
    ).map(({ start, showLabel }) =>
      start.kind === 'event' ? { id: start.trigger.id, showLabel } : start
    )
  ).toEqual([
    { id: 's', showLabel: true },
    { id: 'g', showLabel: true }
  ])
})

it('keeps the approved single-event Details free of a duplicate trigger label', () => {
  expect(
    automationReceiptStartDetails(
      { ...automation, on: [{ id: 'g', source: 'github', event: 'comment' }] },
      undefined
    ).map(({ start, showLabel }) =>
      start.kind === 'event' ? { id: start.trigger.id, showLabel } : start
    )
  ).toEqual([{ id: 'g', showLabel: false }])
})
