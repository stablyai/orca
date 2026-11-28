import { describe, expect, it } from 'vitest'
import type { Automation } from './automations/automation-definition'
import { assertAutomationEventTriggers, EVENT_ONLY_SCHEDULE } from './automation-event-triggers'

describe('results to a thread on a wait no event starts', () => {
  it('is refused, saying how to answer the thread you are in', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only schedule, once, on and bot
    const wait = {
      ...EVENT_ONLY_SCHEDULE,
      once: { by: Date.UTC(2026, 10, 26, 17) },
      bot: { botId: 'b1', runsIn: 'new', resultsTo: 'thread' }
    } as Automation
    expect(() => assertAutomationEventTriggers(wait)).toThrow(
      "make it from that thread's chat and leave out --runs-in and --results-to"
    )
  })
})
