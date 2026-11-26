import { describe, expect, it } from 'vitest'
import { getAgentResumeArgv } from '../../agent-launch/startup/agent-resume-argv'
import { resolveHookSource } from '../../agent-hook-listener/source-routing'
import { resolveTerminalTitleAgentType } from '../../agent-status/title/terminal-title-agent-type'
import { extractAgentProviderSession, isResumableTuiAgent } from './agent-session-resume'

describe('Kimchi terminal lifecycle', () => {
  it('routes status hooks and title identities to Kimchi', () => {
    expect(resolveHookSource('/hook/kimchi')).toBe('kimchi')
    expect(resolveTerminalTitleAgentType('⠋ Kimchi')).toBe('kimchi')
    expect(resolveTerminalTitleAgentType('Kimchi ready')).toBe('kimchi')
    expect(resolveTerminalTitleAgentType('Kimchi - action required')).toBe('kimchi')
  })

  it('captures persisted sessions and resumes them by file', () => {
    const providerSession = extractAgentProviderSession('kimchi', {
      session_id: 'session-1',
      session_file: '/home/user/.config/kimchi/harness/sessions/session-1.jsonl'
    })

    expect(isResumableTuiAgent('kimchi')).toBe(true)
    expect(providerSession).toEqual({
      key: 'session_id',
      id: 'session-1',
      transcriptPath: '/home/user/.config/kimchi/harness/sessions/session-1.jsonl'
    })
    expect(getAgentResumeArgv('kimchi', providerSession!)).toEqual([
      'kimchi',
      '--session',
      '/home/user/.config/kimchi/harness/sessions/session-1.jsonl'
    ])
  })

  it('does not advertise ephemeral sessions without a transcript file', () => {
    expect(extractAgentProviderSession('kimchi', { session_id: 'session-1' })).toBeNull()
  })
})
