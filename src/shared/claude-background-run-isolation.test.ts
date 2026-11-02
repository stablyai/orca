import { expect, it, vi } from 'vitest'
import {
  runClaudeBackgroundAttempts,
  runClaudeGenerationAttempts,
  type ClaudeGenerationAttempt
} from './claude-background-run-isolation'

it('rebuilds only after a canonical nonzero completed exit, at most twice', async () => {
  const canonical = 'You cannot use --strict-mcp-config when an enterprise MCP config is present'
  for (const [agentId, exitCode, stderr, eligible] of [
    ['claude', 1, canonical, true],
    [
      'claude',
      1,
      'Failed reading enterprise MCP config; --strict-mcp-config was requested.',
      false
    ],
    ['claude', 0, canonical, false],
    ['claude', null, canonical, false],
    ['codex', 1, canonical, false]
  ] as const) {
    const result = { exitCode, stdout: '', stderr }
    const retryResult = { ...result, stdout: 'retry output' }
    const run = vi.fn(async (strictMcp: boolean) => (strictMcp ? result : retryResult))
    expect(
      await runClaudeBackgroundAttempts({ agentId, run, failedExit: (outcome) => outcome })
    ).toBe(eligible ? retryResult : result)
    expect(run.mock.calls).toEqual(eligible ? [[true], [false]] : [[true]])
  }
})

// Copied from CLI 2.0.30's stderr; every CLI from 1.0.69 to 2.0.42 prints the same.
const DONT_ASK_REFUSAL =
  "error: option '--permission-mode <mode>' argument 'dontAsk' is invalid. Allowed choices are acceptEdits, bypassPermissions, default, plan.\n"
const ENTERPRISE = 'You cannot use --strict-mcp-config when an enterprise MCP config is present'

it('steps down to legacy tool syntax only after a completed parser refusal', async () => {
  for (const [agentId, exitCode, stdout, stderr, eligible] of [
    ['claude', 1, '', DONT_ASK_REFUSAL, true],
    ['claude', 1, '', "error: unknown option '--tools'\n", false],
    ['claude', 1, '', 'API Error: 529 Overloaded', false],
    ['claude', 1, DONT_ASK_REFUSAL, '', false],
    ['claude', 0, '', DONT_ASK_REFUSAL, false],
    ['claude', null, '', DONT_ASK_REFUSAL, false],
    ['codex', 1, '', DONT_ASK_REFUSAL, false]
  ] as const) {
    const result = { exitCode, stdout, stderr }
    const retryResult = { exitCode: 0, stdout: 'retry output', stderr: '' }
    const run = vi.fn(async (attempt: ClaudeGenerationAttempt) =>
      attempt.legacyToolPolicy ? retryResult : result
    )
    expect(
      await runClaudeGenerationAttempts({ agentId, run, failedExit: (outcome) => outcome })
    ).toBe(eligible ? retryResult : result)
    expect(run.mock.calls).toEqual(
      eligible
        ? [
            [{ strictMcp: true, legacyToolPolicy: false }],
            [{ strictMcp: true, legacyToolPolicy: true }]
          ]
        : [[{ strictMcp: true, legacyToolPolicy: false }]]
    )
  }
})

it('composes both steps once each, keeping whichever came first', async () => {
  // An old CLI under an enterprise MCP config refuses the syntax first, then strict mode.
  const oldEnterpriseCli = async (attempt: ClaudeGenerationAttempt) =>
    !attempt.legacyToolPolicy
      ? { exitCode: 1, stdout: '', stderr: DONT_ASK_REFUSAL }
      : attempt.strictMcp
        ? { exitCode: 1, stdout: '', stderr: ENTERPRISE }
        : { exitCode: 0, stdout: 'Fix crash', stderr: '' }
  // A CLI that keeps refusing both still stops after one step of each.
  const alwaysRefusing = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: `${ENTERPRISE}\n${DONT_ASK_REFUSAL}`
  })
  for (const cli of [oldEnterpriseCli, alwaysRefusing]) {
    const run = vi.fn(cli)
    await runClaudeGenerationAttempts({ agentId: 'claude', run, failedExit: (outcome) => outcome })
    expect(run.mock.calls.map(([attempt]) => attempt)).toEqual(
      cli === oldEnterpriseCli
        ? [
            { strictMcp: true, legacyToolPolicy: false },
            { strictMcp: true, legacyToolPolicy: true },
            { strictMcp: false, legacyToolPolicy: true }
          ]
        : [
            { strictMcp: true, legacyToolPolicy: false },
            { strictMcp: false, legacyToolPolicy: false },
            { strictMcp: false, legacyToolPolicy: true }
          ]
    )
  }
})
