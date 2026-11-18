import { describe, expect, it } from 'vitest'
import type { WaitEnding } from '../automation-once'
import { automationRunCoversWaitEnded } from './automation-run-message'

const ended: WaitEnding = { kind: 'event', at: 100, actor: 'Nora' }
const run = { automation: { id: 'wait-1', name: 'Nora replies' }, wait: ended }

function card(automationId: string, ending: WaitEnding) {
  return { automation: { id: automationId }, ending }
}

describe('automationRunCoversWaitEnded', () => {
  it('covers only the card of the same wait ending the same way', () => {
    expect(automationRunCoversWaitEnded(run, card('wait-1', { kind: 'event', at: 100 }))).toBe(true)
    expect(automationRunCoversWaitEnded(run, card('wait-2', { kind: 'event', at: 100 }))).toBe(
      false
    )
    expect(automationRunCoversWaitEnded(run, card('wait-1', { kind: 'deadline', at: 100 }))).toBe(
      false
    )
    expect(automationRunCoversWaitEnded(run, card('wait-1', { kind: 'event', at: 101 }))).toBe(
      false
    )
    expect(
      automationRunCoversWaitEnded({ automation: run.automation }, card('wait-1', ended))
    ).toBe(false)
  })
})
