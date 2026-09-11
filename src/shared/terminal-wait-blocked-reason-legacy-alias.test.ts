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

  // Why no alias: this build still publishes it, so aliasing it would rename a live reason rather
  // than reinterpret an older host's -- and 'codex just got an upgrade' does name Codex.
  it('leaves the agent-specific codex-model-migration-prompt alone', () => {
    expect(agentNeutralTerminalWaitBlockedReason('codex-model-migration-prompt')).toBeNull()
  })

  it.each(['agent-approval-prompt', 'agent-trust-workspace', 'agent-hooks-review-prompt'] as const)(
    'reports no alias for the already-neutral %s',
    (reason) => {
      expect(agentNeutralTerminalWaitBlockedReason(reason)).toBeNull()
    }
  )

  // Why: the reason is JSON off the wire with no enum to validate it, and an object-literal lookup
  // would answer these from Object.prototype -- the CLI would then print a function to the user.
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'reports no alias for the prototype key %s',
    (reason) => {
      expect(
        agentNeutralTerminalWaitBlockedReason(reason as RuntimeTerminalWaitBlockedReason)
      ).toBeNull()
    }
  )
})

// Why one formatter: the CLI's wait/show output and the worker and federation "Agent startup
// blocked:" receipts all render this token, and only the CLI used to alias it.
describe('describeTerminalWaitBlockedReason', () => {
  it('names the neutral spelling beside a legacy token', () => {
    expect(describeTerminalWaitBlockedReason('codex-trust-workspace')).toBe(
      'codex-trust-workspace (agent-trust-workspace)'
    )
  })

  it.each([
    'agent-trust-workspace',
    'codex-model-migration-prompt',
    // Why pinned: this reason was born neutral, so it has no older spelling to annotate. An alias
    // entry for it would invent one and print it at all four render sites.
    'agent-credential-prompt'
  ] as const)('renders %s unannotated', (reason) => {
    expect(describeTerminalWaitBlockedReason(reason)).toBe(reason)
  })

  it('has no legacy alias for the credential prompt', () => {
    expect(agentNeutralTerminalWaitBlockedReason('agent-credential-prompt')).toBeNull()
  })
})
