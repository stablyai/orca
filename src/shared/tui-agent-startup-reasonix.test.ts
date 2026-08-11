import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'

describe('reasonix startup plans', () => {
  it('terminates Reasonix options before a flag-shaped prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'reasonix',
      prompt: '--version',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("reasonix -- '--version'")
  })

  it('launches Reasonix with argv prompt delivery and yolo defaults', () => {
    const plan = buildAgentStartupPlan({
      agent: 'reasonix',
      prompt: 'fix the tests',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('reasonix', null),
      platform: 'linux'
    })
    expect(plan).toEqual({
      agent: 'reasonix',
      launchCommand: "reasonix '--yolo' -- 'fix the tests'",
      expectedProcess: 'reasonix',
      followupPrompt: null,
      launchConfig: {
        agentCommand: "reasonix '--yolo'",
        agentArgs: '--yolo',
        agentEnv: {}
      }
    })
  })
})
