import { describe, expect, it } from 'vitest'
import { getAgentResumeArgv } from './agent-resume-argv'
import type { AgentProviderSessionMetadata } from '../../agent-session/lifecycle/agent-session-resume'

describe('getAgentResumeArgv hermes', () => {
  const session = (overrides: Partial<AgentProviderSessionMetadata>): AgentProviderSessionMetadata => ({
    key: 'session_id',
    id: 'abc-123',
    ...overrides
  })

  it('resumes a live session into the profile its hook reported', () => {
    expect(getAgentResumeArgv('hermes', session({ hermesProfile: 'work' }))).toEqual([
      'hermes',
      '-p',
      'work',
      '--resume',
      'abc-123'
    ])
  })

  it('falls back to the profile a history row named with its state.db path', () => {
    expect(
      getAgentResumeArgv(
        'hermes',
        session({ transcriptPath: '/h/.hermes/profiles/work/state.db#abc-123' })
      )
    ).toEqual(['hermes', '-p', 'work', '--resume', 'abc-123'])
  })

  it('names the root store as the default profile', () => {
    expect(getAgentResumeArgv('hermes', session({ transcriptPath: '/h/.hermes/state.db#abc-123' })))
      .toEqual(['hermes', '-p', 'default', '--resume', 'abc-123'])
  })

  it('resumes a profile-less session with the bare command', () => {
    expect(getAgentResumeArgv('hermes', session({}))).toEqual(['hermes', '--resume', 'abc-123'])
  })
})
