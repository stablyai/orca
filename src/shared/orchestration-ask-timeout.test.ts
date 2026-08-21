import { describe, expect, it } from 'vitest'
import {
  clampOrchestrationAskTimeoutMs,
  ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS,
  ORCHESTRATION_ASK_MAX_TIMEOUT_MS,
  resolveOrchestrationAskClientTimeoutMs
} from './orchestration-ask-timeout'
import { MAX_TIMER_DELAY_MS } from './timer-delay'

describe('orchestration ask timeout policy', () => {
  it('defaults and clamps to the shared server maximum', () => {
    expect(clampOrchestrationAskTimeoutMs(undefined)).toBe(ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS)
    expect(clampOrchestrationAskTimeoutMs(1_000)).toBe(1_000)
    expect(clampOrchestrationAskTimeoutMs(ORCHESTRATION_ASK_MAX_TIMEOUT_MS)).toBe(
      ORCHESTRATION_ASK_MAX_TIMEOUT_MS
    )
    expect(clampOrchestrationAskTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      ORCHESTRATION_ASK_MAX_TIMEOUT_MS
    )
    expect(clampOrchestrationAskTimeoutMs(-5)).toBe(0)
  })

  it('leaves room for the longest outer ask transport grace', () => {
    expect(resolveOrchestrationAskClientTimeoutMs(ORCHESTRATION_ASK_MAX_TIMEOUT_MS)).toBe(1_805_000)
    expect(ORCHESTRATION_ASK_MAX_TIMEOUT_MS + 3 * 60_000).toBeLessThan(MAX_TIMER_DELAY_MS)
  })
})
