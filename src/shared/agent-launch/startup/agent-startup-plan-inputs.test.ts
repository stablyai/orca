import { describe, expect, it } from 'vitest'
import { agentLaunchQuotingShell } from './agent-launch-runtime'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'

describe('agent startup quoting when configured Git Bash is missing', () => {
  it('resolves startup plan shell to powershell when configured git-bash is unavailable on win32', () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'omp',
      settings: { terminalWindowsShell: 'git-bash' },
      platform: 'win32',
      isRemote: false,
      shell: undefined,
      gitBashAvailable: false
    })

    expect(inputs.shell).toBe('powershell')
  })

  it('quotes AgentLaunchRuntime as powershell when configured git-bash is unavailable on win32', () => {
    expect(
      agentLaunchQuotingShell({
        platform: 'win32',
        pty: { shellOverride: 'git-bash', terminalWindowsWslDistro: null },
        gitBashAvailable: false
      })
    ).toBe('powershell')
  })
})
