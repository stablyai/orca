import { describe, expect, it } from 'vitest'
import {
  agentNeutralTerminalWaitBlockedReason,
  describeTerminalWaitBlockedReason
} from './terminal-wait-blocked-reason-legacy-alias'
import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

describe('agentNeutralTerminalWaitBlockedReason', () => {
  it.each([
    ['codex-update-prompt', 'agent-update-prompt'],
    ['codex-trust-workspace', 'agent-trust-workspace'],
    ['codex-cwd-prompt', 'agent-cwd-prompt'],
    ['codex-hooks-review-prompt', 'agent-hooks-review-prompt'],
    ['codex-interactive-prompt', 'agent-interactive-prompt']
  ] as const)('renames %s published by an older host to %s', (legacy, neutral) => {
    expect(agentNeutralTerminalWaitBlockedReason(legacy)).toBe(neutral)
  })

  // This build still publishes the Codex-specific migration reason; aliasing would rename a live reason, not interpret an old host.
  it('leaves the agent-specific codex-model-migration-prompt alone', () => {
    expect(agentNeutralTerminalWaitBlockedReason('codex-model-migration-prompt')).toBeNull()
  })

  it.each(['agent-approval-prompt', 'agent-trust-workspace', 'agent-hooks-review-prompt'] as const)(
    'reports no alias for the already-neutral %s',
    (reason) => {
      expect(agentNeutralTerminalWaitBlockedReason(reason)).toBeNull()
    }
  )

  // Wire tokens are unvalidated; prototype keys must not resolve to Object.prototype functions.
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'reports no alias for the prototype key %s',
    (reason) => {
      expect(
        agentNeutralTerminalWaitBlockedReason(reason as RuntimeTerminalWaitBlockedReason)
      ).toBeNull()
    }
  )
})

// Share neutral rendering across CLI wait/show and worker/federation startup-blocked receipts.
describe('describeTerminalWaitBlockedReason', () => {
  it('names the neutral spelling beside a legacy token', () => {
    expect(describeTerminalWaitBlockedReason('codex-trust-workspace')).toBe(
      'codex-trust-workspace (agent-trust-workspace)'
    )
  })

  it.each(['agent-trust-workspace', 'codex-model-migration-prompt'] as const)(
    'renders %s unannotated',
    (reason) => {
      expect(describeTerminalWaitBlockedReason(reason)).toBe(reason)
    }
  )
})
