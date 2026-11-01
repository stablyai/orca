import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { resolveResumeLaunchRecipe } from './tui-agent-launch-defaults'
import type { SleepingAgentLaunchConfig } from './agent-session/lifecycle/agent-session-resume'

const FULL_ACCESS: SleepingAgentLaunchConfig = {
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}

function resume(launchConfig: SleepingAgentLaunchConfig | undefined) {
  return buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    cmdOverrides: {},
    platform: 'linux',
    ...resolveResumeLaunchRecipe(launchConfig)
  })
}

describe('buildAgentResumeStartupPlan launch recipe', () => {
  it('keeps a recorded Full-access recipe across repeated restores', () => {
    const first = resume(FULL_ACCESS)
    const second = resume(first?.launchConfig)
    const third = resume(second?.launchConfig)

    expect(third?.launchConfig).toMatchObject({ agentArgs: FULL_ACCESS.agentArgs })
    expect(third?.launchCommand).toContain('--dangerously-skip-permissions')
  })

  it('keeps a missing recipe unrecorded instead of recording a flagless one', () => {
    const plan = resume(undefined)

    expect(plan?.launchCommand).not.toContain('--dangerously-skip-permissions')
    expect(plan?.launchConfig).toMatchObject({ agentArgs: '', unrecorded: true })
    expect(resume(plan?.launchConfig)?.launchConfig.unrecorded).toBe(true)
  })

  it('does not mark a recorded flagless recipe as unrecorded', () => {
    const flagless = { agentCommand: 'claude', agentArgs: '', agentEnv: {} }

    expect(resume(flagless)?.launchConfig.unrecorded).toBeUndefined()
  })
})
