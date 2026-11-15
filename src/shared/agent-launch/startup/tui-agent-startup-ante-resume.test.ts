import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

describe('Ante hibernation and cold restore', () => {
  it('resumes the pane on its own session folder, replaying the captured invocation', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'ante',
      providerSession: { key: 'session_id', id: 'ses_01TESTING000000000000' },
      cmdOverrides: {},
      agentCommand: 'ante --yolo',
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.launchCommand).toBe("ante --yolo '--resume' 'ses_01TESTING000000000000'")
  })
})
