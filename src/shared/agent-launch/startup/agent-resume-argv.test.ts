import { describe, expect, it } from 'vitest'
import { getAgentResumeArgv } from './agent-resume-argv'

describe('getAgentResumeArgv', () => {
  it('resumes mistral-vibe with the documented --resume flag', () => {
    expect(getAgentResumeArgv('mistral-vibe', { key: 'session_id', id: 'abc123' })).toEqual([
      'vibe',
      '--resume',
      'abc123'
    ])
  })

  it('returns null for a non-session mistral-vibe key', () => {
    expect(getAgentResumeArgv('mistral-vibe', { key: 'conversation_id', id: 'abc123' })).toBeNull()
  })
})
