import { describe, expect, it } from 'vitest'
import {
  extractAgentProviderSession,
  getAgentResumeArgv,
  isResumableTuiAgent
} from './agent-session-resume'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

describe('Cursor conversation continuity', () => {
  it('captures only the hook conversation identity', () => {
    expect(isResumableTuiAgent('cursor')).toBe(true)
    expect(
      extractAgentProviderSession('cursor', {
        conversation_id: 'conversation-742',
        session_id: 'tool-session'
      })
    ).toEqual({ key: 'conversation_id', id: 'conversation-742' })
    expect(extractAgentProviderSession('cursor', { session_id: 'tool-session' })).toBeNull()
    expect(extractAgentProviderSession('cursor', { conversation_id: '--continue' })).toBeNull()
    expect(
      extractAgentProviderSession('cursor', { conversation_id: 'session\ncommand' })
    ).toBeNull()
  })

  it('resumes the exact conversation instead of the latest one', () => {
    expect(
      getAgentResumeArgv('cursor', { key: 'conversation_id', id: 'conversation-742' })
    ).toEqual(['cursor-agent', '--resume', 'conversation-742'])
    expect(getAgentResumeArgv('cursor', { key: 'session_id', id: 'tool-session' })).toBeNull()
  })

  it.each(['linux', 'darwin', 'win32'] as const)(
    'preserves the configured executable and launch recipe on %s',
    (platform) => {
      const plan = buildAgentResumeStartupPlan({
        agent: 'cursor',
        providerSession: { key: 'conversation_id', id: 'conversation-742' },
        cmdOverrides: { cursor: 'custom-cursor' },
        platform,
        agentArgs: '--mode ask'
      })
      expect(plan?.launchCommand).toContain('custom-cursor')
      expect(plan?.launchCommand).toContain('conversation-742')
      expect(plan?.launchCommand).toContain('--resume')
      expect(plan?.launchCommand).toContain('--mode')
      expect(plan?.launchCommand).not.toContain('--continue')
    }
  )
})
