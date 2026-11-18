import { describe, expect, it } from 'vitest'
import type { Automation } from '../automations/automation-definition'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import { botAutomationWhenParts } from './bot-automation-when'

function automation(overrides: Partial<Automation>): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the parts read only the fields set here.
  return { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', dtstart: 0, ...overrides } as Automation
}

describe('botAutomationWhenParts', () => {
  it('lists the schedule, then each event', () => {
    expect(
      botAutomationWhenParts(
        automation({ on: [{ id: 't1', source: 'slack', event: 'mentioned' }] })
      )
    ).toEqual([
      { kind: 'schedule', schedule: { kind: 'daily', hour: 9, minute: 0 } },
      { kind: 'event', trigger: { id: 't1', source: 'slack', event: 'mentioned' } }
    ])
  })

  it('leaves out the schedule of an event-only automation', () => {
    expect(
      botAutomationWhenParts(
        automation({
          ...EVENT_ONLY_SCHEDULE,
          on: [{ id: 't2', source: 'linear', event: 'assigned' }]
        })
      )
    ).toEqual([{ kind: 'event', trigger: { id: 't2', source: 'linear', event: 'assigned' } }])
  })
})
