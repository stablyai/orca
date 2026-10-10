import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { mergeExtraAgentArgs } from './automation-extra-agent-args'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'

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
      extraAgentArgs: '--model opus --add-dir "my docs"'
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'go' })
    expect(plan?.launchCommand).toContain('opus')
    expect(plan?.launchCommand).not.toContain('sonnet')
    expect(plan?.launchCommand).toContain('--dangerously-skip-permissions')
  })

  it('builds the same command the desktop path builds', () => {
    const headless = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: SETTINGS,
      platform: 'darwin',
      isRemote: false,
      extraAgentArgs: '--effort high'
    })
    const desktopArgs = mergeExtraAgentArgs({
      agent: 'claude',
      defaultArgs: resolveTuiAgentLaunchArgs('claude', SETTINGS.agentDefaultArgs),
      extraAgentArgs: '--effort high',
      shell: 'posix'
    })
    if (!desktopArgs.ok) {
      throw new Error(desktopArgs.error)
    }
    const desktop = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'go',
      cmdOverrides: {},
      platform: 'darwin',
      agentArgs: desktopArgs.agentArgs
    })
    expect(buildAgentStartupPlan({ ...headless, prompt: 'go' })?.launchCommand).toBe(
      desktop?.launchCommand
    )
  })

  it('throws on extras the executing host refuses', () => {
    expect(() =>
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: SETTINGS,
        platform: 'linux',
        isRemote: false,
        extraAgentArgs: '--permission-mode bypassPermissions'
      })
    ).toThrow('"--permission-mode"')
  })

  it('leaves launches without extras untouched', () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: SETTINGS,
      platform: 'linux',
      isRemote: false,
      agentArgs: null,
      extraAgentArgs: '  '
    })
    expect(inputs.agentArgs).toBeNull()
  })
})
