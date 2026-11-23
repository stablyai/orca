import { expect, it } from 'vitest'
import type { BotAutomationFacts } from '../bots/bot-automation-rows'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import { automationReceiptFacts } from './automation-receipt-facts'
import {
  automationReceiptStartDetails,
  automationReceiptStartSet,
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

it('proves a deadline-only wait only from a complete V1, and never lists an unknown start', () => {
  const complete = automationReceiptFacts({ createdAt: 10 })
  const deadlineOnly = { starts: [{ kind: 'deadline', at: 5000 }] }
  expect(automationReceiptStartSet(automation, complete)).toEqual({
    ...deadlineOnly,
    alternativesUnproven: false
  })
  for (const unproven of [
    automationReceiptStartSet(automation, undefined),
    automationReceiptStartSet(automation, complete, true),
    automationReceiptStartSet(automation, {
      version: 1,
      automationCreatedAt: 10,
      zone: { kind: 'not-recorded' },
      triggerExtras: { coverage: 'partial', items: [] }
    }),
    automationReceiptStartSet(automation, {
      version: 1,
      unavailable: 'item-budget'
    })
  ]) {
    expect(unproven).toEqual({ ...deadlineOnly, alternativesUnproven: true })
  }
})

const slack = {
  id: 's',
  source: 'slack' as const,
  event: 'message' as const,
  in: ['#ops']
}
const gmail = {
  id: 'g',
  source: 'gmail' as const,
  event: 'new_email' as const
}
const slackOther = { ...slack, in: ['#other'] }
const slackExtra = { triggerId: 's', additionalConditions: 'none' as const }
const gmailExtra = {
  triggerId: 'g',
  additionalConditions: 'none' as const,
  google: { kind: 'gmail' as const, account: { kind: 'host-only' as const } }
}
function v1(items: unknown[], coverage: 'complete' | 'partial' = 'complete'): unknown {
  return {
    version: 1,
    automationCreatedAt: 10,
    zone: { kind: 'not-recorded' },
    triggerExtras: { coverage, items }
  }
}

it('keeps complete event-plus-deadline and event-only waits exact', () => {
  const wait = { ...automation, on: [slack, gmail] }
  const set = automationReceiptStartSet(wait, v1([slackExtra, gmailExtra]))
  expect(set.alternativesUnproven).toBe(false)
  expect(set.starts.map((start) => start.kind)).toEqual(['event', 'event', 'deadline'])
  const eventOnly = automationReceiptStartSet(
    { ...automation, once: {}, on: [slack] },
    v1([slackExtra])
  )
  expect(eventOnly).toEqual({
    starts: [{ kind: 'event', trigger: slack, extra: slackExtra }],
    alternativesUnproven: false
  })
})

it.each([
  ['legacy', [slack], undefined],
  ['partial', [slack], v1([slackExtra], 'partial')],
  ['missing extra', [slack, gmail], v1([slackExtra])],
  ['orphan extra', [slack], v1([slackExtra, gmailExtra])],
  ['mismatched Google arm', [slack, gmail], v1([slackExtra, { ...gmailExtra, google: undefined }])],
  ['duplicate base id', [slack, slackOther], v1([slackExtra])],
  ['duplicate extra id', [slack], v1([slackExtra, slackExtra])]
] as const)(
  'keeps retained %s wait starts and the deadline but leaves alternatives unproven',
  (_case, on, facts) => {
    const set = automationReceiptStartSet({ ...automation, on: [...on] }, facts)
    expect(set.alternativesUnproven).toBe(true)
    expect(set.starts.filter((start) => start.kind === 'event')).toHaveLength(on.length)
    expect(set.starts.at(-1)).toEqual({ kind: 'deadline', at: 5000 })
    expect(set.starts.some((start) => start.kind === 'unknown')).toBe(false)
  }
)

it('withholds shortened place strings and treats a shortened wait as unproven', () => {
  const set = automationReceiptStartSet({ ...automation, on: [slack] }, v1([slackExtra]), true)
  expect(set).toEqual({
    starts: [
      { kind: 'event', trigger: slack, extra: null, placeWithheld: true },
      { kind: 'deadline', at: 5000 }
    ],
    alternativesUnproven: true
  })
})

it('drops extras for an ambiguous base id but keeps independent valid extras', () => {
  const starts = automationReceiptStarts(
    { ...automation, once: undefined, on: [slack, slackOther, gmail] },
    v1([slackExtra, gmailExtra])
  )
  expect(starts).toEqual([
    { kind: 'event', trigger: slack, extra: null },
    { kind: 'event', trigger: slackOther, extra: null },
    { kind: 'event', trigger: gmail, extra: gmailExtra }
  ])
})

it('trusts no extra when the saved facts repeat an extra id', () => {
  const starts = automationReceiptStarts(
    { ...automation, once: undefined, on: [slack, gmail] },
    v1([slackExtra, slackExtra, gmailExtra])
  )
  expect(starts).toEqual([
    { kind: 'event', trigger: slack, extra: null },
    { kind: 'event', trigger: gmail, extra: null }
  ])
})

it('keeps custom cron and unknown recurrence zone literal, rather than inventing a preset', () => {
  expect(
    automationReceiptStarts(
      { ...automation, once: undefined, dtstart: 0, rrule: '0 */6 * * *' },
      undefined
    )
  ).toEqual([
    {
      kind: 'schedule',
      schedule: { kind: 'custom', expression: '0 */6 * * *' },
      zone: null
    }
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
        on: [
          {
            id: 'other',
            source: 'calendar',
            event: 'starting_soon',
            minutesBefore: 60
          }
        ]
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
      {
        ...automation,
        enabled: false,
        once: undefined,
        dtstart: 0,
        rrule: '0 */6 * * *'
      },
      {
        version: 1,
        automationCreatedAt: 10,
        zone: { kind: 'effective-at-save', iana: 'UTC' },
        triggerExtras: { coverage: 'complete', items: [] }
      }
    ).scopes
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
            google: {
              kind: 'gmail',
              account: { kind: 'named', value: 'personal@example.test' }
            }
          },
          {
            triggerId: 'team',
            additionalConditions: 'present',
            google: {
              kind: 'gmail',
              account: { kind: 'named', value: 'team@example.test' }
            }
          },
          { triggerId: 'slack', additionalConditions: 'unknown' }
        ]
      }
    }
  ).scopes
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
      {
        ...automation,
        once: undefined,
        on: [{ id: 's', source: 'slack', event: 'message' }]
      },
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
              google: {
                kind: 'gmail',
                account: { kind: 'named', value: 'unrelated@example.test' }
              }
            }
          ]
        }
      }
    )
  ).toEqual([
    {
      kind: 'event',
      trigger: { id: 's', source: 'slack', event: 'message' },
      extra: null
    }
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
    ).scopes.map(({ start, showLabel }) =>
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
    ).scopes.map(({ start, showLabel }) =>
      start.kind === 'event' ? { id: start.trigger.id, showLabel } : start
    )
  ).toEqual([{ id: 'g', showLabel: false }])
})
