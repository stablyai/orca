import { describe, expect, it } from 'vitest'
import type { CustomAgentProfile } from './custom-agent-profile'
import { buildCustomAgentAutomationStartupPlan } from './custom-agent-automation-startup'

const codexLuna: CustomAgentProfile = {
  id: 'codex-luna',
  name: 'Codex Luna',
  baseAgent: 'codex',
  baseAgentExecutable: 'codex',
  executable: 'codex',
  args: ['--model', 'luna']
}

describe('buildCustomAgentAutomationStartupPlan', () => {
  it('keeps Codex identity while adding the prompt to the profile argv', () => {
    const plan = buildCustomAgentAutomationStartupPlan({
      profile: codexLuna,
      prompt: 'Review this change',
      platform: 'linux',
      shell: 'posix'
    })

    expect(plan).toMatchObject({
      agent: 'codex',
      launchCommand: "'codex' '--model' 'luna' 'Review this change'",
      followupPrompt: null,
      startupCommandDelivery: 'shell-ready',
      launchConfig: {
        agentCommand: "'codex'",
        agentArgs: "'--model' 'luna'"
      }
    })
  })

  it('carries exact argv through the Windows launch transport', () => {
    const plan = buildCustomAgentAutomationStartupPlan({
      profile: codexLuna,
      prompt: 'Review & fix',
      platform: 'win32',
      shell: 'powershell'
    })
    const encodedLaunch = plan?.env?.ORCA_CUSTOM_AGENT_WINDOWS_RUNNER_V1

    expect(encodedLaunch).toBeTypeOf('string')
    if (!encodedLaunch) {
      throw new Error('Missing Windows launch transport')
    }
    const launch = JSON.parse(Buffer.from(encodedLaunch, 'base64').toString('utf8'))
    expect(launch.executable).toBe('codex')
    expect(launch.runner).toContain('"--model" "luna" "Review & fix"')
  })

  it('uses the provider follow-up path when the base agent requires stdin', () => {
    const plan = buildCustomAgentAutomationStartupPlan({
      profile: {
        id: 'aider-fast',
        name: 'Aider Fast',
        baseAgent: 'aider',
        baseAgentExecutable: 'aider',
        executable: 'aider',
        args: ['--model', 'fast']
      },
      prompt: 'Run tests',
      platform: 'linux',
      shell: 'posix'
    })

    expect(plan).toMatchObject({
      agent: 'aider',
      launchCommand: "'aider' '--model' 'fast'",
      followupPrompt: 'Run tests'
    })
  })

  it('rejects profiles with no known provider prompt contract', () => {
    expect(
      buildCustomAgentAutomationStartupPlan({
        profile: {
          id: 'dhimanex',
          name: 'Dhimanex',
          executable: 'dhimanex',
          args: []
        },
        prompt: 'Run tests',
        platform: 'linux',
        shell: 'posix'
      })
    ).toBeNull()
  })
})
