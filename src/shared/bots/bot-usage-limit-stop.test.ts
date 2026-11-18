import { describe, expect, it } from 'vitest'
import type { AgentSessionStatusSummary } from '../agent-session/agent-session-wire'
import { usageLimitStopOf, usageLimitStops } from './bot-usage-limit-stop'

const NOW = 1_000_000
const RESET = 2_000_000

function summary(
  sessionId: string,
  workspaceId: string,
  usageLimitContinue?: AgentSessionStatusSummary['usageLimitContinue']
): AgentSessionStatusSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only these fields.
  return {
    sessionId,
    workspaceId,
    agent: 'claude',
    conversationName: 'Look around',
    usageLimitContinue
  } as AgentSessionStatusSummary
}

describe('usageLimitStopOf', () => {
  it('continues at the scheduled time while Orca will continue it', () => {
    expect(
      usageLimitStopOf(
        {
          usageLimitContinue: {
            turnItemId: 't',
            resetsAt: RESET,
            continueAt: 2_500_000,
            state: 'scheduled'
          }
        },
        NOW
      )
    ).toEqual({ at: 2_500_000, auto: true })
  })

  it('is no stop once the reset has passed or without a cut', () => {
    expect(
      usageLimitStopOf(
        { usageLimitContinue: { turnItemId: 't', resetsAt: RESET, state: 'off' } },
        RESET
      )
    ).toBeNull()
    expect(usageLimitStopOf({}, NOW)).toBeNull()
  })

  it('keeps a continuing stop for ten minutes past its time, until Orca sends', () => {
    const cut = { turnItemId: 't', resetsAt: RESET, state: 'scheduled' } as const
    expect(usageLimitStopOf({ usageLimitContinue: cut }, RESET + 9 * 60_000)).toEqual({
      at: RESET,
      auto: true
    })
    expect(usageLimitStopOf({ usageLimitContinue: cut }, RESET + 10 * 60_000)).toBeNull()
  })
})

describe('usageLimitStops', () => {
  it('lists stopped sessions soonest first, with their workspace and name', () => {
    const sessions = new Map([
      ['a', summary('a', 'home', { turnItemId: 't', resetsAt: 3_000_000, state: 'off' })],
      ['b', summary('b', 'worker', { turnItemId: 't', resetsAt: RESET, state: 'scheduled' })],
      ['c', summary('c', 'home')]
    ])
    expect(usageLimitStops(sessions, NOW)).toEqual([
      {
        at: RESET,
        auto: true,
        sessionId: 'b',
        workspaceId: 'worker',
        name: 'Look around',
        agent: 'claude'
      },
      {
        at: 3_000_000,
        auto: false,
        sessionId: 'a',
        workspaceId: 'home',
        name: 'Look around',
        agent: 'claude'
      }
    ])
  })
})
