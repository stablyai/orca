import { describe, expect, it } from 'vitest'
import {
  AGENT_STALL_EPISODE_RESET_MS,
  AGENT_STALL_OBSERVATION_TTL_MS,
  getAgentStallCausePolicy,
  nextAgentStallLedgerEntry,
  getAgentStallRetryDelayMs,
  planAgentStallRecovery,
  type AgentStallObservation,
  type AgentStallRecoveryLedgerEntry,
  type AgentStallRecoveryPaneFacts
} from './agent-stall-recovery-policy'

const NOW = 1_700_000_000_000

function observation(overrides: Partial<AgentStallObservation> = {}): AgentStallObservation {
  return {
    paneKey: 'tab-a:leaf-a',
    cause: 'network',
    signature: 'Connection error',
    observedAt: NOW - 60_000,
    ...overrides
  }
}

function facts(overrides: Partial<AgentStallRecoveryPaneFacts> = {}): AgentStallRecoveryPaneFacts {
  return { worktreeId: 'wt-1', status: 'done', addressable: true, ...overrides }
}

function plan({
  observations,
  paneFacts,
  ledger = {},
  now = NOW,
  force
}: {
  observations: readonly AgentStallObservation[]
  paneFacts: Record<string, AgentStallRecoveryPaneFacts | undefined>
  ledger?: Record<string, AgentStallRecoveryLedgerEntry | undefined>
  now?: number
  force?: boolean
}): ReturnType<typeof planAgentStallRecovery> {
  return planAgentStallRecovery({ observations, paneFacts, ledger, now, force })
}

describe('planAgentStallRecovery', () => {
  it('recovers every stalled pane in one plan, longest-stalled first', () => {
    const result = plan({
      observations: [
        observation({ paneKey: 'tab-b:leaf-b', observedAt: NOW - 30_000 }),
        observation({ paneKey: 'tab-a:leaf-a', observedAt: NOW - 90_000 }),
        observation({ paneKey: 'tab-c:leaf-c', observedAt: NOW - 60_000, cause: 'auth' })
      ],
      paneFacts: {
        'tab-a:leaf-a': facts(),
        'tab-b:leaf-b': facts({ worktreeId: 'wt-2' }),
        'tab-c:leaf-c': facts({ worktreeId: 'wt-3' })
      }
    })

    expect(result.skipped).toEqual([])
    expect(result.steps.map((step) => step.paneKey)).toEqual([
      'tab-a:leaf-a',
      'tab-c:leaf-c',
      'tab-b:leaf-b'
    ])
    expect(result.steps.every((step) => step.attempt === 1)).toBe(true)
  })

  it('lets the CLI finish its own retry before the first network attempt', () => {
    const settleMs = getAgentStallCausePolicy('network').settleMs

    const result = plan({
      observations: [observation({ observedAt: NOW - settleMs + 1 })],
      paneFacts: { 'tab-a:leaf-a': facts() }
    })

    expect(result.steps).toEqual([])
    expect(result.skipped).toEqual([{ paneKey: 'tab-a:leaf-a', reason: 'settling' }])
  })

  it('backs off exponentially between attempts and then gives up', () => {
    const ledgerAt = (attempts: number, lastAttemptAt: number): AgentStallRecoveryLedgerEntry => ({
      cause: 'network',
      attempts,
      lastAttemptAt
    })
    const secondAttemptDelay = getAgentStallRetryDelayMs('network', 1)
    const thirdAttemptDelay = getAgentStallRetryDelayMs('network', 2)

    expect(thirdAttemptDelay).toBe(secondAttemptDelay * 2)

    const tooSoon = plan({
      observations: [observation()],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: { 'tab-a:leaf-a': ledgerAt(1, NOW - secondAttemptDelay + 1) }
    })
    expect(tooSoon.skipped).toEqual([{ paneKey: 'tab-a:leaf-a', reason: 'backoff' }])

    const due = plan({
      observations: [observation()],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: { 'tab-a:leaf-a': ledgerAt(1, NOW - secondAttemptDelay) }
    })
    expect(due.steps[0]?.attempt).toBe(2)

    const exhausted = plan({
      observations: [observation()],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: {
        'tab-a:leaf-a': ledgerAt(getAgentStallCausePolicy('network').maxAttempts, NOW - 1_000)
      }
    })
    expect(exhausted.skipped).toEqual([{ paneKey: 'tab-a:leaf-a', reason: 'attempts-exhausted' }])
  })

  it('gives an exhausted pane a fresh budget once a new stall episode starts', () => {
    const spent: AgentStallRecoveryLedgerEntry = {
      cause: 'network',
      attempts: getAgentStallCausePolicy('network').maxAttempts,
      lastAttemptAt: NOW - AGENT_STALL_EPISODE_RESET_MS - 120_000
    }

    const sameEpisode = plan({
      observations: [observation({ observedAt: spent.lastAttemptAt - 1_000 })],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: { 'tab-a:leaf-a': spent }
    })
    expect(sameEpisode.skipped).toEqual([{ paneKey: 'tab-a:leaf-a', reason: 'attempts-exhausted' }])

    const newEpisode = plan({
      observations: [observation({ observedAt: NOW - 60_000 })],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: { 'tab-a:leaf-a': spent }
    })
    expect(newEpisode.steps[0]?.attempt).toBe(1)
  })

  it('counts attempts within one episode as the ledger is written', () => {
    const first = nextAgentStallLedgerEntry(undefined, {
      cause: 'network',
      observedAt: NOW - 60_000,
      attemptedAt: NOW
    })
    expect(first).toEqual({ cause: 'network', attempts: 1, lastAttemptAt: NOW })

    const second = nextAgentStallLedgerEntry(first, {
      cause: 'network',
      observedAt: NOW - 60_000,
      attemptedAt: NOW + 30_000
    })
    expect(second.attempts).toBe(2)

    const laterEpisode = nextAgentStallLedgerEntry(second, {
      cause: 'network',
      observedAt: NOW + 30_000 + AGENT_STALL_EPISODE_RESET_MS + 1,
      attemptedAt: NOW + 30_000 + AGENT_STALL_EPISODE_RESET_MS + 2
    })
    expect(laterEpisode.attempts).toBe(1)
  })

  it('force overrides the waiting fences but never the unrecoverable ones', () => {
    const forced = plan({
      observations: [
        observation({ paneKey: 'waiting:leaf-a', observedAt: NOW - 1_000 }),
        observation({ paneKey: 'busy:leaf-a' })
      ],
      paneFacts: { 'waiting:leaf-a': facts(), 'busy:leaf-a': facts({ status: 'working' }) },
      ledger: {
        'waiting:leaf-a': {
          cause: 'network',
          attempts: getAgentStallCausePolicy('network').maxAttempts,
          lastAttemptAt: NOW - 100
        }
      },
      force: true
    })

    expect(forced.steps.map((step) => step.paneKey)).toEqual(['waiting:leaf-a'])
    expect(forced.skipped).toEqual([{ paneKey: 'busy:leaf-a', reason: 'agent-working' }])
  })

  it('caps the backoff so a long-broken login keeps being retried', () => {
    const policy = getAgentStallCausePolicy('auth')

    expect(getAgentStallRetryDelayMs('auth', 20)).toBe(policy.retryMaxMs)
    expect(getAgentStallRetryDelayMs('auth', 0)).toBe(0)
  })

  it('starts a fresh budget when the failure changes cause', () => {
    const result = plan({
      observations: [observation({ cause: 'auth', observedAt: NOW - 10_000 })],
      paneFacts: { 'tab-a:leaf-a': facts() },
      ledger: { 'tab-a:leaf-a': { cause: 'network', attempts: 5, lastAttemptAt: NOW - 1_000 } }
    })

    expect(result.steps).toEqual([
      { paneKey: 'tab-a:leaf-a', worktreeId: 'wt-1', cause: 'auth', attempt: 1 }
    ])
  })

  // Regression: nudging a `working` agent queued a duplicate prompt behind the
  // one Claude was already retrying (observed live at "attempt 6/10").
  it('never nudges an agent that is mid-turn, even when forced', () => {
    const working = { 'tab-a:leaf-a': facts({ status: 'working' }) }

    const result = plan({ observations: [observation()], paneFacts: working })
    expect(result.skipped).toEqual([{ paneKey: 'tab-a:leaf-a', reason: 'agent-working' }])

    const forced = plan({ observations: [observation()], paneFacts: working, force: true })
    expect(forced.steps).toEqual([])
  })

  it('recovers once the mid-turn agent settles', () => {
    const result = plan({
      observations: [observation()],
      paneFacts: { 'tab-a:leaf-a': facts({ status: 'done' }) }
    })

    expect(result.steps).toHaveLength(1)
  })

  it('skips panes it cannot address', () => {
    const result = plan({
      observations: [
        observation({ paneKey: 'unmounted:leaf-a' }),
        observation({ paneKey: 'ghost:leaf-a' }),
        observation({
          paneKey: 'ancient:leaf-a',
          observedAt: NOW - AGENT_STALL_OBSERVATION_TTL_MS - 1
        })
      ],
      paneFacts: {
        'unmounted:leaf-a': facts({ addressable: false }),
        'ancient:leaf-a': facts()
      }
    })

    expect(result.steps).toEqual([])
    expect(new Map(result.skipped.map((skip) => [skip.paneKey, skip.reason]))).toEqual(
      new Map([
        ['unmounted:leaf-a', 'not-addressable'],
        ['ghost:leaf-a', 'unknown-pane'],
        ['ancient:leaf-a', 'expired']
      ])
    )
  })
})

describe('rate-limit window gating', () => {
  const PANE = 'tab-a:leaf-a'
  const limited = observation({ cause: 'rate-limit', signature: 'usage limit reached' })

  it('holds a pane whose provider window has not reopened', () => {
    const result = plan({
      observations: [limited],
      paneFacts: { [PANE]: facts({ rateLimitResetAt: NOW + 60_000 }) }
    })

    expect(result.steps).toEqual([])
    expect(result.skipped).toEqual([{ paneKey: PANE, reason: 'rate-limit-window' }])
  })

  it('holds a pane even when the user asks explicitly — Resume cannot reopen a window', () => {
    // This is the `continue` the user typed by hand, which the CLI answered with
    // the same refusal; the button must not reproduce that.
    const result = plan({
      observations: [limited],
      paneFacts: { [PANE]: facts({ rateLimitResetAt: NOW + 60_000 }) },
      force: true
    })

    expect(result.steps).toEqual([])
    expect(result.skipped).toEqual([{ paneKey: PANE, reason: 'rate-limit-window' }])
  })

  it('holds a pane whose reset time Orca cannot read', () => {
    const result = plan({
      observations: [limited],
      paneFacts: { [PANE]: facts({ rateLimitResetAt: null }) }
    })

    expect(result.skipped).toEqual([{ paneKey: PANE, reason: 'rate-limit-window' }])
  })

  it('continues once the window has reopened', () => {
    const result = plan({
      observations: [limited],
      paneFacts: { [PANE]: facts({ rateLimitResetAt: NOW - 1 }) }
    })

    expect(result.steps).toEqual([
      { paneKey: PANE, worktreeId: 'wt-1', cause: 'rate-limit', attempt: 1 }
    ])
  })

  it('never gates a pane stalled for another reason on a rate-limit window', () => {
    const result = plan({
      observations: [observation({ cause: 'auth' })],
      paneFacts: { [PANE]: facts({ rateLimitResetAt: NOW + 60_000 }) }
    })

    expect(result.steps).toHaveLength(1)
  })
})
