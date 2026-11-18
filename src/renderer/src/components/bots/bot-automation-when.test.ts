import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import { makeAutomation } from '../automations/automations-page-fixtures'
import { botAutomationWhen } from './bot-automation-when'

describe('botAutomationWhen', () => {
  it('tells two events apart by where they listen', () => {
    const thread = 'slack:T05:C0ORCA:1.2'
    expect(
      botAutomationWhen(
        makeAutomation({
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
