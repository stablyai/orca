import { describe, expect, it } from 'vitest'
import { getAgentForkArgv } from './agent-resume-argv'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION = { key: 'session_id', id: 's1' } as const

describe('agent fork startup', () => {
  it('forks Claude and Codex and nothing else', () => {
    expect(getAgentForkArgv('claude', SESSION)).toEqual([
      'claude',
      '--resume',
      's1',
      '--fork-session'
    ])
    expect(getAgentForkArgv('codex', SESSION)).toEqual(['codex', 'fork', 's1'])
    expect(getAgentForkArgv('gemini', SESSION)).toBeNull()
    expect(getAgentForkArgv('claude', { key: 'conversation_id', id: 's1' })).toBeNull()
  })

  it('builds a Claude fork plan that replaces a stored resume selector', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: SESSION,
      cmdOverrides: { claude: 'claude --continue' },
      platform: 'darwin',
      fork: true
    })

    expect(plan?.launchCommand).toBe("claude '--resume' 's1' '--fork-session'")
  })

  it('builds a Codex fork plan that opens in the launch folder', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: SESSION,
      cmdOverrides: {},
      platform: 'darwin',
      resumeInLaunchCwd: true,
      fork: true
    })

    expect(plan?.launchCommand).toBe("codex '-c' 'tui.resume_cwd=current' 'fork' 's1'")
  })

  it('refuses a fork for an agent that cannot fork rather than resuming it', () => {
    expect(
      buildAgentResumeStartupPlan({
        agent: 'gemini',
        providerSession: SESSION,
        cmdOverrides: {},
        platform: 'darwin',
        fork: true
      })
    ).toBeNull()
  })
})
