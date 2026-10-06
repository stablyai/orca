import { describe, expect, it } from 'vitest'
import { hasExplicitTuiLaunchCommand } from './tui-agent-launch-command-override'

describe('hasExplicitTuiLaunchCommand', () => {
  it('treats a whitespace-only command override as no override', () => {
    expect(hasExplicitTuiLaunchCommand({ agentCmdOverrides: { codex: '   ' } }, 'codex')).toBe(
      false
    )
    expect(
      hasExplicitTuiLaunchCommand({ agentCmdOverrides: { codex: 'codex-nightly' } }, 'codex')
    ).toBe(true)
  })
})
