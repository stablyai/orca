import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const providerSession = { key: 'session_id', id: 'claude-session-1' } as const

describe('resume with a continue prompt', () => {
  const base = { cmdOverrides: {}, platform: 'linux' as const, shell: 'posix' as const }

  it('submits the prompt on resume for Claude and Codex', () => {
    const claude = buildAgentResumeStartupPlan({
      ...base,
      agent: 'claude',
      providerSession,
      continuePrompt: 'continue'
    })
    expect(claude?.launchCommand).toMatch(/'?--resume'? '?claude-session-1'? '?continue'?$/)
    const codex = buildAgentResumeStartupPlan({
      ...base,
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'codex-1' },
      continuePrompt: 'continue'
    })
    expect(codex?.launchCommand).toMatch(/'?resume'? '?codex-1'? '?continue'?$/)
  })

  it('leaves other agents and empty prompts unchanged', () => {
    const plain = buildAgentResumeStartupPlan({ ...base, agent: 'claude', providerSession })
    const blank = buildAgentResumeStartupPlan({
      ...base,
      agent: 'claude',
      providerSession,
      continuePrompt: '  '
    })
    expect(blank?.launchCommand).toBe(plain?.launchCommand)
    const cursor = buildAgentResumeStartupPlan({
      ...base,
      agent: 'cursor',
      providerSession: { key: 'conversation_id', id: 'c-1' },
      continuePrompt: 'continue'
    })
    expect(cursor?.launchCommand).not.toMatch(/continue'?$/)
  })
})
