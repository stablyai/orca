import { describe, expect, it } from 'vitest'
import {
  clampTerminalSubmitVerdictTimeoutMs,
  DEFAULT_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS,
  isTerminalSubmitDelivered,
  MAX_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS
} from './terminal-submit-verdict'

describe('clampTerminalSubmitVerdictTimeoutMs', () => {
  it('keeps a positive fractional bound waiting at all', () => {
    // Why: truncating 0.5 to 0 would skip the evidence wait and answer from the pre-write snapshot,
    // which reads as a real verdict from a wait that never happened.
    expect(clampTerminalSubmitVerdictTimeoutMs(0.5)).toBe(1)
    expect(clampTerminalSubmitVerdictTimeoutMs(1.9)).toBe(1)
  })

  it('truncates a larger fractional bound without dropping it', () => {
    expect(clampTerminalSubmitVerdictTimeoutMs(1500.7)).toBe(1500)
  })

  it('falls back to the default for a missing or non-positive bound', () => {
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampTerminalSubmitVerdictTimeoutMs(value)).toBe(
        DEFAULT_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS
      )
    }
  })

  it('caps the bound so a request cannot park an RPC worker', () => {
    expect(clampTerminalSubmitVerdictTimeoutMs(10 * MAX_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS)).toBe(
      MAX_TERMINAL_SUBMIT_VERDICT_TIMEOUT_MS
    )
  })
})

describe('isTerminalSubmitDelivered', () => {
  it('reads an absent verdict as undelivered', () => {
    // Why: a host that predates the field cannot answer, and silence is unknown, never success.
    expect(isTerminalSubmitDelivered(undefined)).toBe(false)
  })

  it('accepts only submitted', () => {
    expect(
      isTerminalSubmitDelivered({ status: 'submitted', reason: 'turn-start-observed', waitedMs: 1 })
    ).toBe(true)
    for (const status of ['queued', 'pending', 'unknown'] as const) {
      expect(
        isTerminalSubmitDelivered({ status, reason: 'no-turn-start-observed', waitedMs: 1 })
      ).toBe(false)
    }
  })
})
