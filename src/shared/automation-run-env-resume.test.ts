import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'

const automationEnv = {
  ORCA_AUTOMATION_ID: 'automation-1',
  ORCA_AUTOMATION_NAME: 'Nightly triage',
  ORCA_AUTOMATION_RUN_ID: 'run-1',
  ORCA_AUTOMATION_RUN_NUMBER: '4',
  ORCA_AUTOMATION_RUN_TRIGGER: 'scheduled'
}

describe('run identity and durable resume state', () => {
  it('keeps the run identity out of the record a later resume re-spawns from', () => {
    const config = buildSleepingAgentLaunchConfig({
      agentEnv: { ...automationEnv, ANTHROPIC_MODEL: 'opus' }
    })

    expect(config.agentEnv).toEqual({ ANTHROPIC_MODEL: 'opus' })
  })

  it('still gives the automation launch itself the full identity', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'Triage the backlog',
      cmdOverrides: {},
      agentEnv: automationEnv,
      platform: 'darwin',
      isRemote: false
    })

    expect(plan?.env).toEqual(automationEnv)
    expect(plan?.launchConfig.agentEnv).toEqual({})
  })
})
