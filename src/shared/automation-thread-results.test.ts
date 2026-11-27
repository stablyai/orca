import { describe, expect, it } from 'vitest'
import type { Automation } from './automations/automation-definition'
import {
  assertAutomationEventTriggers,
  EVENT_ONLY_SCHEDULE,
  THREAD_RESULTS_NEED_A_THREAD
} from './automation-event-triggers'

const ORIGIN = {
  source: 'slack',
  externalId: 'T1:C1:1700000000.000100',
  place: '#design',
  sessionId: 'thread-chat'
} as const

function wait(bot: Automation['bot']): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the code under test reads only these fields
  return { ...EVENT_ONLY_SCHEDULE, once: { by: Date.UTC(2026, 10, 26, 17) }, bot } as Automation
}

describe('results to a thread on an automation no event starts', () => {
  it('is taken for one made answering a thread', () => {
    expect(() =>
      assertAutomationEventTriggers(
        wait({ botId: 'b1', runsIn: 'new', resultsTo: 'thread', originThread: ORIGIN })
      )
    ).not.toThrow()
  })

  it('is refused otherwise, naming what works', () => {
    expect(() =>
      assertAutomationEventTriggers(wait({ botId: 'b1', runsIn: 'new', resultsTo: 'thread' }))
    ).toThrow(THREAD_RESULTS_NEED_A_THREAD)
    expect(THREAD_RESULTS_NEED_A_THREAD).toContain('leave out --runs-in and --results-to')
  })
})
