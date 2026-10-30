import { describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS,
  ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS,
  ORCHESTRATION_READINESS_TIMEOUT_MS,
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS,
  isWorkerStartTimeoutWithinTimerLimit,
  resolveFederationAttachDeadlineMs,
  resolveFederationAttachTimeoutMs,
  resolveWorkerStartClientTimeoutMs
} from './orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from './timer-delay'

describe('orchestration timing budgets', () => {
  it('keeps the worker-start budget strictly nested', () => {
    const readiness = ORCHESTRATION_READINESS_TIMEOUT_MS
    const verify = readiness + AGENT_PROMPT_EFFECT_TIMEOUT_MS
    const federated = resolveFederationAttachTimeoutMs(readiness)
    const outer = resolveWorkerStartClientTimeoutMs(readiness)

    expect(ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS + federated).toBeLessThan(outer)
    expect(verify).toBeLessThan(federated)
    expect(federated).toBeLessThan(outer)
    expect(ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS).toBeGreaterThan(AGENT_PROMPT_EFFECT_TIMEOUT_MS)
    expect(ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS).toBeGreaterThan(
      ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS
    )
  })

  it('caps attach at the outer deadline after preflight', () => {
    expect(
      resolveFederationAttachDeadlineMs({
        readinessTimeoutMs: 60_000,
        outerDeadlineMs: 105_000,
        nowMs: 10_000
      })
    ).toBe(95_000)
  })

  it('accepts the exact maximum readiness timeout and rejects the first overflow', () => {
    const maxValid = MAX_TIMER_DELAY_MS - ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
    expect(isWorkerStartTimeoutWithinTimerLimit(maxValid)).toBe(true)
    expect(isWorkerStartTimeoutWithinTimerLimit(maxValid + 1)).toBe(false)
  })

  it('keeps ordinary defaults within the timer limit', () => {
    expect(isWorkerStartTimeoutWithinTimerLimit(undefined)).toBe(true)
    expect(isWorkerStartTimeoutWithinTimerLimit(0)).toBe(true)
  })
})
