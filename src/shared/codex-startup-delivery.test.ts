import { describe, expect, it } from 'vitest'
import { shouldUseShellReadyStartupDelivery } from './codex-startup-delivery'

describe('shouldUseShellReadyStartupDelivery', () => {
  it('honors explicit shell-ready startup plans', () => {
    expect(
      shouldUseShellReadyStartupDelivery({
        command: "codex 'fix it'",
        startupCommandDelivery: 'shell-ready'
      })
    ).toBe(true)
  })

  it('stays on the fast path without an explicit shell-ready hint', () => {
    expect(shouldUseShellReadyStartupDelivery({ command: 'codex' })).toBe(false)
    expect(
      shouldUseShellReadyStartupDelivery({
        command: "codex 'please compare --prefill behavior'"
      })
    ).toBe(false)
  })

  it('does not treat mythical Codex --prefill tokens as native draft delivery', () => {
    // Why: Codex has no --prefill flag. Old detection forced shell-ready for
    // fake argv that would never be produced by buildAgentStartupPlan.
    expect(
      shouldUseShellReadyStartupDelivery({
        command: "codex --prefill 'linked issue context'"
      })
    ).toBe(false)
    expect(
      shouldUseShellReadyStartupDelivery({
        command: 'codex --prefill=review'
      })
    ).toBe(false)
  })

  it('does not force shell-ready for Claude --prefill (native Claude path)', () => {
    expect(
      shouldUseShellReadyStartupDelivery({
        command: "claude --prefill 'review this'"
      })
    ).toBe(false)
  })
})
