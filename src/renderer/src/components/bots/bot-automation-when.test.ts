import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { botAutomationWhen } from './bot-automation-when'

function automation(overrides: Partial<Automation>): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the label reads only rrule, dtstart and on.
  return {
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    ...overrides
  } as Automation
}

describe('botAutomationWhen', () => {
  it('words a schedule', () => {
    expect(botAutomationWhen(automation({}))).toBe('Weekdays at 9:00 AM')
  })

  it('words an event-only automation by its events, not its placeholder schedule', () => {
    expect(
      botAutomationWhen(
        automation({
          ...EVENT_ONLY_SCHEDULE,
          on: [
            { id: 't1', source: 'slack', event: 'mentioned' },
            { id: 't2', source: 'github', event: 'ci_failed' }
          ]
        })
      )
    ).toBe('When you’re mentioned in Slack · When CI fails')
  })

  it('lists a schedule before the events that also start it', () => {
    expect(
      botAutomationWhen(automation({ on: [{ id: 't1', source: 'linear', event: 'assigned' }] }))
    ).toBe('Weekdays at 9:00 AM · When assigned in Linear')
  })

  it('tells two events apart by where they listen', () => {
    const thread = 'slack:T05:C0ORCA:1.2'
    expect(
      botAutomationWhen(
        automation({
          ...EVENT_ONLY_SCHEDULE,
          on: [
            {
              id: 't1',
              source: 'slack',
              event: 'message',
              subject: thread,
              from: ['U1'],
              names: { [thread]: '#orca', U1: 'Nora' }
            },
            {
              id: 't2',
              source: 'slack',
              event: 'message',
              in: ['slack:T05:C0ENG'],
              names: { 'slack:T05:C0ENG': '#eng' }
            },
            { id: 't3', source: 'slack', event: 'message', in: ['slack:T05:C0OLD'] }
          ]
        })
      )
    ).toBe(
      'On a Slack message in a thread in #orca · On a Slack message in #eng · On a Slack message in a Slack channel'
    )
  })
})
