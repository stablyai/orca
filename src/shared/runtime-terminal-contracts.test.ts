import { describe, expect, it } from 'vitest'
import { formatWorkerBlockedReason } from './runtime-terminal-contracts'

describe('formatWorkerBlockedReason', () => {
  it('attributes a trust block to the launching agent, not codex (#15123)', () => {
    expect(formatWorkerBlockedReason('codex-trust-workspace', 'antigravity')).toBe(
      'Agent startup blocked: antigravity workspace trust prompt (codex-trust-workspace)'
    )
  })

  it('keeps the codex reason for codex launches', () => {
    expect(formatWorkerBlockedReason('codex-trust-workspace', 'codex')).toBe(
      'Agent startup blocked: codex-trust-workspace'
    )
  })

  it('keeps the reason when no agent is known', () => {
    expect(formatWorkerBlockedReason('codex-trust-workspace')).toBe(
      'Agent startup blocked: codex-trust-workspace'
    )
    expect(formatWorkerBlockedReason('codex-trust-workspace', null)).toBe(
      'Agent startup blocked: codex-trust-workspace'
    )
  })

  it('leaves non-trust reasons untouched', () => {
    expect(formatWorkerBlockedReason('codex-update-prompt', 'antigravity')).toBe(
      'Agent startup blocked: codex-update-prompt'
    )
    expect(formatWorkerBlockedReason('agent-approval-prompt', 'antigravity')).toBe(
      'Agent startup blocked: agent-approval-prompt'
    )
  })
})
