import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('Junie startup plan', () => {
  it('launches Junie with --prompt so the prompt never becomes a headless batch task', () => {
    const plan = buildAgentStartupPlan({
      agent: 'junie',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '',
      platform: 'linux'
    })

    // Why: `junie 'fix it'` (positional) runs one batch task and exits; only
    // `--prompt` auto-submits into the interactive TUI Orca hosts.
    expect(plan?.launchCommand).toBe("junie --prompt 'fix it'")
  })

  it('launches Junie bare when there is no prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'junie',
      prompt: '',
      cmdOverrides: {},
      agentArgs: '',
      agentEnv: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('junie')
  })
})
