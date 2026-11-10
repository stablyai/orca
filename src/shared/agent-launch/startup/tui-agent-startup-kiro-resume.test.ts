import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

describe('Kiro cold restore', () => {
  it('preserves the captured engine and agent selection on a remote host', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: { key: 'session_id', id: 'session-1' },
      cmdOverrides: {},
      agentCommand: 'kiro-cli chat --tui --v2 --agent reviewer',
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.launchCommand).toBe(
      "kiro-cli chat --tui --v2 --agent reviewer '--resume-id' 'session-1'"
    )
  })
})
