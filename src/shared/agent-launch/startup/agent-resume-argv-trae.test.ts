import { describe, expect, it } from 'vitest'
import { isResumableTuiAgent } from '../../agent-session/lifecycle/agent-session-resume'
import { getAgentResumeArgv } from './agent-resume-argv'

describe('Trae resume argv', () => {
  it('treats trae as a resumable TUI agent', () => {
    expect(isResumableTuiAgent('trae')).toBe(true)
  })

  it('builds traecli --resume from a session_id', () => {
    expect(getAgentResumeArgv('trae', { key: 'session_id', id: 'trae-session' })).toEqual([
      'traecli',
      '--resume',
      'trae-session'
    ])
  })

  it('rejects trae resume when the provider session key is not session_id', () => {
    expect(getAgentResumeArgv('trae', { key: 'conversation_id', id: 'x' })).toBeNull()
  })
})
