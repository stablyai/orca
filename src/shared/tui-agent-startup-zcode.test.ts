import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('ZCode startup plans', () => {
  it('uses stdin-after-start prompt delivery for the interactive client', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'fix the tests',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toEqual({
      agent: 'zcode',
      launchCommand: 'zcode',
      expectedProcess: 'zcode-cli',
      followupPrompt: 'fix the tests',
      launchConfig: { agentCommand: 'zcode', agentArgs: '', agentEnv: {} }
    })
  })
})
