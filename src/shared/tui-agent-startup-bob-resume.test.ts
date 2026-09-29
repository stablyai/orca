import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION = { key: 'session_id' as const, id: '5f0c9a52-3d1e-4b7a-9c61-2e8f4d7a1b03' }

describe('Bob resume startup plan', () => {
  it('appends only --resume to the chat launch command', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'bob',
      providerSession: SESSION,
      cmdOverrides: {},
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe(`bob chat --trust '--resume' '${SESSION.id}'`)
  })

  it('keeps a command override and still resumes once', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'bob',
      providerSession: SESSION,
      cmdOverrides: { bob: 'bob chat --trust --auto-approve' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(`bob chat --trust --auto-approve '--resume' '${SESSION.id}'`)
  })
})
