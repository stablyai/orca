import { expect, it } from 'vitest'
import { automationReceiptFacts, readAutomationReceiptFacts } from './automation-receipt-facts'
import { assertAutomationEventTriggers, EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import type { Automation } from './automation-definition'

it('preserves Calendar timing/default scope and records conditions without leaking predicates', () => {
  expect(
    automationReceiptFacts(
      {
        createdAt: 100,
        on: [
          {
            id: 'g',
            source: 'gmail',
            event: 'new_email',
            account: 'work@example.com',
            subjectContains: 'secret',
            from: ['private@example.com']
          },
          { id: 'c', source: 'calendar', event: 'starting_soon', minutesBefore: 0 }
        ]
      },
      'America/Los_Angeles'
    )
  ).toEqual({
    version: 1,
    automationCreatedAt: 100,
    zone: { kind: 'effective-at-save', iana: 'America/Los_Angeles' },
    triggerExtras: {
      coverage: 'complete',
      items: [
        {
          triggerId: 'c',
          additionalConditions: 'none',
          google: {
            kind: 'calendar',
            minutesBefore: 0,
            account: { kind: 'host-only' },
            calendar: 'primary'
          }
        },
        {
          triggerId: 'g',
          additionalConditions: 'present',
          google: { kind: 'gmail', account: { kind: 'named', value: 'work@example.com' } }
        }
      ]
    }
  })
})

it('omits an accepted overlong Google identity whole and declares partial coverage', () => {
  const on: Automation['on'] = [
    { id: 'x'.repeat(129), source: 'calendar', event: 'starting_soon', minutesBefore: 60 }
  ]
  const automation = {
    on,
    createdAt: 1,
    bot: { botId: 'b', runsIn: 'new' },
    ...EVENT_ONLY_SCHEDULE
  }
  // The source accepts this id; the receipt projection has its own smaller bound.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this validator reads only the trigger, bot and schedule fields supplied above.
  expect(() => assertAutomationEventTriggers(automation as Automation)).not.toThrow()
  expect(automationReceiptFacts(automation)).toEqual({
    version: 1,
    automationCreatedAt: 1,
    zone: { kind: 'not-recorded' },
    triggerExtras: { coverage: 'partial', items: [] }
  })
})

it('bounds multibyte account facts in UTF-8, without slicing an identity or account', () => {
  const result = automationReceiptFacts({
    createdAt: 1,
    on: Array.from({ length: 20 }, (_, index) => ({
      id: `g-${index.toString().padStart(2, '0')}`,
      source: 'gmail' as const,
      event: 'new_email' as const,
      account: '界'.repeat(200)
    }))
  })
  expect(Buffer.byteLength(JSON.stringify({ receiptFacts: result }))).toBeLessThanOrEqual(8192)
  expect(result).toMatchObject({ triggerExtras: { coverage: 'partial' } })
  if ('unavailable' in result) {
    throw new Error('Expected a partial receipt')
  }
  expect(result.triggerExtras.items[0]).toEqual({
    triggerId: 'g-00',
    additionalConditions: 'none',
    google: { kind: 'gmail', account: { kind: 'named', value: '界'.repeat(200) } }
  })
  expect(result.triggerExtras.items.length).toBeGreaterThan(0)
})

it('admits the BMP identity before an astral identity at the UTF-8 byte boundary', () => {
  const result = automationReceiptFacts({
    createdAt: 1,
    on: ['\u{10000}', '\uE000', ...Array.from({ length: 10 }, (_, i) => `g-0${i}`)].map((id) => ({
      id,
      source: 'gmail' as const,
      event: 'new_email' as const,
      account: '界'.repeat(200)
    }))
  })
  if ('unavailable' in result) {
    throw new Error('Expected a partial receipt')
  }
  expect(result.triggerExtras.coverage).toBe('partial')
  expect(result.triggerExtras.items.map((extra) => extra.triggerId)).toEqual([
    'g-00',
    'g-01',
    'g-02',
    'g-03',
    'g-04',
    'g-05',
    'g-06',
    'g-07',
    'g-08',
    'g-09',
    '\uE000'
  ])
  // These eleven extras occupy 7998 bytes; admitting both Unicode identities would need 8713.
  expect(Buffer.byteLength(JSON.stringify({ receiptFacts: result }))).toBe(7998)
})

it('ignores the entire extension for unsupported clients, future versions or damaged data', () => {
  const facts = automationReceiptFacts({ createdAt: 1 }, 'UTC')
  expect(readAutomationReceiptFacts(facts, false)).toBeUndefined()
  expect(readAutomationReceiptFacts({ ...facts, version: 2 })).toBeUndefined()
  expect(readAutomationReceiptFacts({ version: 1, unavailable: 'future' })).toBeUndefined()
})
