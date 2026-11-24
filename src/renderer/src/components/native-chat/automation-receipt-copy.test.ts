import { expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import { automationReceiptSummary } from './automation-receipt-copy'

// The folded line may only read as the full set of wait alternatives when the receipt proves it.

const slack = {
  id: 's',
  source: 'slack' as const,
  event: 'message' as const,
  in: ['C1'],
  names: { C1: '#ops-…' }
}
const slackExtra = { triggerId: 's', additionalConditions: 'none' as const }
const deadline = Date.UTC(2027, 1, 1, 17)

function wait(on: (typeof slack)[], receiptFacts?: unknown) {
  return {
    change: 'created' as const,
    automation: {
      id: 'w',
      name: 'Wait',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 1,
      workspaceId: null,
      ...EVENT_ONLY_SCHEDULE,
      on,
      once: { by: deadline }
    },
    receiptFacts
  }
}
const complete = (items: unknown[]): unknown => ({
  version: 1,
  automationCreatedAt: 1,
  zone: { kind: 'not-recorded' },
  triggerExtras: { coverage: 'complete', items }
})

it('reads a proven event-plus-deadline wait as its exact alternatives', () => {
  const text = automationReceiptSummary(wait([slack], complete([slackExtra])))
  expect(text).toMatch(/^Saved: On a Slack message .*#ops-….*, or .* — whichever came first$/)
  expect(text).not.toMatch(/may not be listed/)
})

it('qualifies a legacy wait with a retained event instead of implying an exhaustive list', () => {
  const text = automationReceiptSummary(wait([slack]))
  expect(text).toMatch(/— whichever came first; other start conditions may not be listed$/)
})

it('does not present a zero-retained unknown start as another trigger', () => {
  const text = automationReceiptSummary(wait([]))
  expect(text).not.toMatch(/weren’t recorded|whichever came first/)
  expect(text).toMatch(/^Saved: .*; other start conditions may not be listed$/)
})

it('qualifies a retained count rather than stating an exact number', () => {
  const three = [slack, { ...slack, id: 't' }, { ...slack, id: 'u' }]
  expect(automationReceiptSummary(wait(three))).toBe('Saved: at least 4 start conditions')
  expect(
    automationReceiptSummary(
      wait(
        three,
        complete(three.map(({ id }) => ({ triggerId: id, additionalConditions: 'none' })))
      )
    )
  ).toBe('Saved: 4 start conditions')
})

it('omits shortened place strings so a clipped value never reads as a saved place', () => {
  const text = automationReceiptSummary(wait([slack], complete([slackExtra])), true)
  expect(text).not.toContain('#ops')
  expect(text).toMatch(/^Saved: On a Slack message, or .*may not be listed$/)
})

function eventOnlyWait(on: (typeof slack)[], receiptFacts?: unknown) {
  const saved = wait(on, receiptFacts)
  return { ...saved, automation: { ...saved.automation, once: {} } }
}

it('qualifies an event-only wait unless its receipt proves the listed starts complete', () => {
  const one = automationReceiptSummary(eventOnlyWait([slack]))
  expect(one).toMatch(/^Saved: On a Slack message.*; other start conditions may not be listed$/)
  expect(one).not.toMatch(/whichever came first/)
  const three = [slack, { ...slack, id: 't' }, { ...slack, id: 'u' }]
  expect(automationReceiptSummary(eventOnlyWait(three))).toBe('Saved: at least 3 start conditions')
  // Control: a complete receipt keeps the exact wording and count.
  expect(automationReceiptSummary(eventOnlyWait([slack], complete([slackExtra])))).not.toMatch(
    /may not be listed/
  )
  expect(
    automationReceiptSummary(
      eventOnlyWait(
        three,
        complete(three.map(({ id }) => ({ triggerId: id, additionalConditions: 'none' })))
      )
    )
  ).toBe('Saved: 3 start conditions')
})
