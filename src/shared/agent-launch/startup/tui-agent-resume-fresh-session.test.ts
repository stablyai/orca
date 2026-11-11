import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const ID = '81eb0bf5-6f2a-4c8e-9d1b-2a3c4d5e6f70'
const base = {
  agent: 'claude' as const,
  providerSession: { key: 'session_id' as const, id: ID },
  cmdOverrides: {},
  platform: 'linux' as const,
  agentArgs: '--model opus --effort high'
}

describe('a fresh start for a session with no transcript', () => {
  it('keeps the pane’s recorded args and the session id, without --resume', () => {
    const plan = buildAgentResumeStartupPlan({ ...base, freshSession: true })
    expect(plan?.launchCommand).toMatch(/--model'? '?opus'? '?--effort'? '?high/)
    expect(plan?.launchCommand).toMatch(new RegExp(`--session-id'? '?${ID}`))
    expect(plan?.launchCommand).not.toContain('--resume')
  })

  it('never sends a continue prompt into a fresh session', () => {
    const plan = buildAgentResumeStartupPlan({
      ...base,
      freshSession: true,
      continuePrompt: 'continue'
    })
    expect(plan?.launchCommand).not.toContain('continue')
  })

  it('resumes as before without the flag, and other agents ignore it', () => {
    expect(buildAgentResumeStartupPlan(base)?.launchCommand).toMatch(
      new RegExp(`--resume'? '?${ID}`)
    )
    const codex = buildAgentResumeStartupPlan({
      ...base,
      agent: 'codex',
      agentArgs: '',
      freshSession: true
    })
    expect(codex?.launchCommand).toMatch(new RegExp(`resume'? '?${ID}`))
  })
})
