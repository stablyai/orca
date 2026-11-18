import { describe, expect, it } from 'vitest'
import type { Automation } from './automations/automation-definition'
import {
  assertAutomationEventTriggers,
  EVENT_ONLY_SCHEDULE,
  takesOwnEvents,
  type AutomationEventTrigger
} from './automation-event-triggers'

const automation = (on: AutomationEventTrigger[]) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only bot, on, once and the schedule, all set here.
  ({
    id: 'auto-1',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    on,
    ...EVENT_ONLY_SCHEDULE
  }) as Automation

describe('your own events on a rule', () => {
  it('start only github.pr_opened', () => {
    expect(takesOwnEvents({ source: 'github', event: 'pr_opened' })).toBe(true)
    expect(takesOwnEvents({ source: 'github', event: 'comment' })).toBe(false)
    expect(() =>
      assertAutomationEventTriggers(
        automation([{ id: 'on-1', source: 'github', event: 'pr_opened', fromOwner: true }])
      )
    ).not.toThrow()
    for (const event of ['comment', 'review', 'pr_pushed', 'issue_opened'] as const) {
      expect(() =>
        assertAutomationEventTriggers(
          automation([{ id: 'on-1', source: 'github', event, fromOwner: true }])
        )
      ).toThrow(`Your own events can start only github.pr_opened, not github.${event}.`)
    }
    expect(() =>
      assertAutomationEventTriggers(
        automation([{ id: 'on-1', source: 'slack', event: 'message', fromOwner: true }])
      )
    ).toThrow('not slack.message')
  })
})
