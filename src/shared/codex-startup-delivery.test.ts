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
    // Why: Codex has no --prefill flag. Only a startup plan that actually
    // carries positional PROMPT may opt into shell-ready command delivery.
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

  it('does not force shell-ready for Claude native prefill', () => {
    expect(
      shouldUseShellReadyStartupDelivery({
        command: "claude --prefill 'review this'"
      })
    ).toBe(false)
  })
})
