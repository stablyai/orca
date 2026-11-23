import { describe, expect, it } from 'vitest'
import { sleepingAgentSessionRecordSchema } from './workspace-session-sleeping-agents'

describe('sleepingAgentSessionRecordSchema hermes profile', () => {
  const record = (providerSession: Record<string, unknown>) => ({
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo-1::/home/user/project',
    agent: 'hermes',
    providerSession,
    prompt: 'hi',
    state: 'waiting',
    capturedAt: 1,
    updatedAt: 2
  })

  it('keeps the profile a slept pane resumes into', () => {
    const parsed = sleepingAgentSessionRecordSchema.parse(
      record({ key: 'session_id', id: 'abc-123', hermesProfile: 'work' })
    )
    expect(parsed.providerSession.hermesProfile).toBe('work')
  })

  it('drops a profile that cannot name a --profile argument', () => {
    const parsed = sleepingAgentSessionRecordSchema.parse(
      record({ key: 'session_id', id: 'abc-123', hermesProfile: 'a;b' })
    )
    expect(parsed.providerSession.hermesProfile).toBeUndefined()
  })
})
