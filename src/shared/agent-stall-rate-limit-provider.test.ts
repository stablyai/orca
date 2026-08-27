import { describe, expect, it } from 'vitest'
import {
  agentStallRateLimitResetAt,
  rateLimitProviderForAgentType
} from './agent-stall-rate-limit-provider'
import type { RateLimitState } from './rate-limit-types'

const SESSION_RESET = 1_700_000_000_000
const WEEKLY_RESET = SESSION_RESET + 3 * 24 * 60 * 60 * 1000

function window(usedPercent: number, resetsAt: number | null) {
  return { usedPercent, windowMinutes: 300, resetsAt, resetDescription: null }
}

function limits(overrides: Partial<RateLimitState['claude']> = {}): RateLimitState {
  return {
    claude: {
      provider: 'claude',
      session: window(100, SESSION_RESET),
      weekly: null,
      updatedAt: 0,
      error: null,
      status: 'ok',
      ...overrides
    }
  } as unknown as RateLimitState
}

describe('rateLimitProviderForAgentType', () => {
  it('maps agents onto the state key, not the provider spelling', () => {
    // RateLimitState calls it `opencodeGo`; the provider string is `opencode-go`.
    expect(rateLimitProviderForAgentType('opencode')).toBe('opencodeGo')
    expect(rateLimitProviderForAgentType('Claude')).toBe('claude')
    expect(rateLimitProviderForAgentType('openclaude')).toBe('claude')
  })

  it('returns null for an agent whose usage Orca does not track', () => {
    expect(rateLimitProviderForAgentType('aider')).toBeNull()
    expect(rateLimitProviderForAgentType(null)).toBeNull()
  })
})

describe('agentStallRateLimitResetAt', () => {
  it('reports the reset of a spent window', () => {
    expect(agentStallRateLimitResetAt(limits(), 'claude')).toBe(SESSION_RESET)
  })

  it('takes the latest spent window, so a weekly cap outlives the session one', () => {
    // Recovering at the session reset would burn the attempt on the weekly cap.
    const state = limits({ session: window(100, SESSION_RESET), weekly: window(100, WEEKLY_RESET) })

    expect(agentStallRateLimitResetAt(state, 'claude')).toBe(WEEKLY_RESET)
  })

  it('ignores a window with headroom left', () => {
    expect(
      agentStallRateLimitResetAt(limits({ session: window(42, SESSION_RESET) }), 'claude')
    ).toBeNull()
  })

  it('reports nothing when the spent window carries no reset time', () => {
    expect(agentStallRateLimitResetAt(limits({ session: window(100, null) }), 'claude')).toBeNull()
  })

  it('reports nothing for an untracked agent or missing state', () => {
    expect(agentStallRateLimitResetAt(limits(), 'aider')).toBeNull()
    expect(agentStallRateLimitResetAt(null, 'claude')).toBeNull()
  })
})
