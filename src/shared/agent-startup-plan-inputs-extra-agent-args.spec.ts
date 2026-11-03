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
      shell: undefined,
      extraAgentArgs: '--model opus --add-dir "my docs"'
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: 'go' })
    expect(plan?.launchCommand).toContain("'--add-dir' 'my docs'")
    expect(plan?.launchCommand).toContain('opus')
    expect(plan?.launchCommand).not.toContain('sonnet')
    expect(plan?.launchCommand).toContain('--dangerously-skip-permissions')
  })

  it('uses Pi extras instead of host model and thinking defaults', () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'pi',
      settings: { agentDefaultArgs: { pi: '--provider old --model old/model --thinking low' } },
      platform: 'linux',
      isRemote: false,
      shell: undefined,
      extraAgentArgs: '--model=new/model --thinking=max'
    })
    const command = buildAgentStartupPlan({ ...inputs, prompt: 'go' })?.launchCommand
    expect(command).toContain("'--model' 'new/model'")
    expect(command).toContain("'--thinking' 'max'")
    expect(command).not.toContain('old/model')
    expect(command).not.toContain("'--provider'")
    expect(command).not.toContain("'low'")
  })

  it.each(['pi --provider old --api-key host-secret', 'env -- pi --api-key host-secret'])(
    'refuses a Pi inline API key in a custom command: %s',
    (command) => {
      expect(() =>
        resolveAgentStartupPlanInputs({
          agent: 'pi',
          settings: { agentCmdOverrides: { pi: command } },
          platform: 'linux',
          isRemote: false,
          shell: undefined,
          extraAgentArgs: '--model new/model'
        })
      ).toThrow(/--api-key/)
    }
  )

  it('does not confuse a custom command operand with an inline API key', () => {
    expect(() =>
      resolveAgentStartupPlanInputs({
        agent: 'pi',
        settings: { agentCmdOverrides: { pi: 'pi --system-prompt --api-key' } },
        platform: 'linux',
        isRemote: false,
        shell: undefined,
        extraAgentArgs: '--model new/model'
      })
    ).not.toThrow()
  })

  it('keeps an inline API key in a custom command when only thinking changes', () => {
    expect(() =>
      resolveAgentStartupPlanInputs({
        agent: 'pi',
        settings: { agentCmdOverrides: { pi: 'pi --provider old --api-key secret' } },
        platform: 'linux',
        isRemote: false,
        shell: undefined,
        extraAgentArgs: '--thinking high'
      })
    ).not.toThrow()
  })

  it('matches explicitly composed launch defaults and extras', () => {
    const headless = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: SETTINGS,
      platform: 'darwin',
      isRemote: false,
      shell: undefined,
      extraAgentArgs: '--effort high'
    })
    const desktopArgs = mergeExtraAgentArgs({
      agent: 'claude',
      defaultArgs: resolveTuiAgentLaunchArgs('claude', SETTINGS),
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
        shell: undefined,
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
      shell: undefined,
      agentArgs: null,
      extraAgentArgs: '  '
    })
    expect(inputs.agentArgs).toBeNull()
  })
})
