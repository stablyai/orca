import { expect, it, vi } from 'vitest'
import { runClaudeBackgroundAttempts } from './claude-background-run-isolation'

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
