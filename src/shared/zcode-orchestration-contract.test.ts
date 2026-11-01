import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('ZCode orchestration and send-to-agent contract', () => {
  it('keeps the prompt out of the launch command and hands it back as a follow-up', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: 'refactor the parser',
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(plan?.launchCommand).toBe('zcode')
    expect(plan?.launchCommand).not.toContain('refactor the parser')
    expect(plan?.followupPrompt).toBe('refactor the parser')
  })

  it('carries a mode chosen through agent args onto the launch command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--mode plan'
    })
    expect(plan?.launchCommand).toBe("zcode '--mode' 'plan'")
  })
})
