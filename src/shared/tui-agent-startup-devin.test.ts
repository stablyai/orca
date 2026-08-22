import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'

describe('Devin workspace-trust skip', () => {
  it('keeps the skip when YOLO args are cleared', () => {
    const plan = buildAgentStartupPlan({
      agent: 'devin',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      agentArgs: '',
      platform: 'linux'
    })
    expect(plan).toEqual({
      agent: 'devin',
      launchCommand: 'devin --respect-workspace-trust=false',
      expectedProcess: 'devin',
      followupPrompt: null,
      launchConfig: {
        agentCommand: 'devin --respect-workspace-trust=false',
        agentArgs: '',
        agentEnv: {}
      }
    })
  })

  it('keeps the skip on resume so a new worktree does not re-prompt', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'devin',
      providerSession: { key: 'session_id', id: 'abc12345' },
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('devin', null),
      platform: 'linux'
    })
    expect(plan?.launchCommand).toBe(
      "devin --respect-workspace-trust=false '--permission-mode' 'bypass' '--resume' 'abc12345'"
    )
  })
})
