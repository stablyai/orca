import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('GitLab Duo startup', () => {
  it('submits the prompt through --goal so the TUI stays interactive', () => {
    const plan = buildAgentStartupPlan({
      agent: 'gitlab-duo',
      prompt: 'fix the failing tests',
      cmdOverrides: {},
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe("glab duo cli --goal 'fix the failing tests'")
    expect(plan?.expectedProcess).toBe('duo')
    expect(plan?.followupPrompt).toBeNull()
  })
})
