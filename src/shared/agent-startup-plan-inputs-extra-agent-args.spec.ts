import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import './automation-extra-agent-args'
import { buildAgentStartupPlan } from './tui-agent-startup'
import './tui-agent-launch-defaults'

const SETTINGS = {
  agentDefaultArgs: { claude: '--dangerously-skip-permissions --model sonnet' },
  terminalWindowsShell: 'powershell.exe'
}

describe('resolveAgentStartupPlanInputs with extra agent args', () => {
  it.each([
    ['linux', false],
    ['win32', false],
    ['win32', true]
  ] as const)('merges over the host defaults on %s (remote %s)', (platform, isRemote) => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: SETTINGS,
      platform,
      isRemote,
      shell: undefined,
      extraAgentArgs: '--model opus --add-dir "my docs"'
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'go' })
    expect(plan?.launchCommand).toContain("'--add-dir' 'my docs'")
    expect(plan?.launchCommand).toContain('opus')
    expect(plan?.launchCommand).not.toContain('sonnet')
    expect(plan?.launchCommand).toContain('--dangerously-skip-permissions')
  })

  it('throws on extras the executing host refuses', () => {
    expect(() =>
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: SETTINGS,
        platform: 'linux',
        isRemote: false,
        shell: undefined,
        extraAgentArgs: '--permission-mode bypassPermissions'
      })
    ).toThrow('"--permission-mode"')
  })
})
