import { describe, expect, it } from 'vitest'
import {
  extractAgentProviderSession,
  getAgentForkArgv,
  getAgentResumeArgv,
  isForkableTuiAgent,
  normalizeAgentProviderSession
} from './agent-session-resume'

describe('agent session resume metadata', () => {
  const piSessionPath = '/home/dev/.pi/agent/sessions/--repo--/20260617_session.jsonl'

  it.each([
    ['claude', { session_id: 'claude-session' }, { key: 'session_id', id: 'claude-session' }],
    ['codex', { session_id: 'codex-session' }, { key: 'session_id', id: 'codex-session' }],
    ['gemini', { session_id: 'gemini-session' }, { key: 'session_id', id: 'gemini-session' }],
    [
      'antigravity',
      { conversationId: 'agy-conversation' },
      { key: 'conversation_id', id: 'agy-conversation' }
    ],
    ['opencode', { sessionID: 'opencode-session' }, { key: 'session_id', id: 'opencode-session' }],
    ['droid', { session_id: 'droid-session' }, { key: 'session_id', id: 'droid-session' }],
    ['grok', { sessionId: 'grok-session' }, { key: 'session_id', id: 'grok-session' }],
    ['pi', { session_path: piSessionPath }, { key: 'session_path', id: piSessionPath }]
  ] as const)('extracts %s provider session ids', (source, payload, expected) => {
    expect(extractAgentProviderSession(source, payload)).toEqual(expected)
  })

  it.each([
    ['claude', { key: 'session_id', id: 's1' }, ['claude', '--resume', 's1']],
    ['codex', { key: 'session_id', id: 's1' }, ['codex', 'resume', 's1']],
    ['gemini', { key: 'session_id', id: 's1' }, ['gemini', '--resume', 's1']],
    ['antigravity', { key: 'conversation_id', id: 's1' }, ['agy', '--conversation', 's1']],
    ['opencode', { key: 'session_id', id: 's1' }, ['opencode', '--session', 's1']],
    ['droid', { key: 'session_id', id: 's1' }, ['droid', '--resume', 's1']],
    ['grok', { key: 'session_id', id: 's1' }, ['grok', '--resume', 's1']]
  ] as const)('builds %s resume argv', (agent, providerSession, expected) => {
    expect(getAgentResumeArgv(agent, providerSession)).toEqual(expected)
  })

  it.each([
    ['claude', { key: 'session_id', id: 's1' }, ['claude', '--fork-session', 's1']],
    ['codex', { key: 'session_id', id: 's1' }, ['codex', 'fork', 's1']],
    ['droid', { key: 'session_id', id: 's1' }, ['droid', '--fork', 's1']],
    ['pi', { key: 'session_path', id: piSessionPath }, ['pi', '--fork', piSessionPath]]
  ] as const)('builds %s fork argv', (agent, providerSession, expected) => {
    expect(isForkableTuiAgent(agent)).toBe(true)
    expect(getAgentForkArgv(agent, providerSession)).toEqual(expected)
  })

  it('does not treat unsupported resumable agents as native-fork capable', () => {
    expect(isForkableTuiAgent('gemini')).toBe(false)
  })

  it('rejects unsupported sources and unsafe ids', () => {
    expect(extractAgentProviderSession('pi', { session_id: 'pi-session' })).toBeNull()
    expect(extractAgentProviderSession('omp', { session_path: piSessionPath })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_id', id: 'bad\nid' })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_id', id: '--last' })).toBeNull()
    expect(extractAgentProviderSession('codex', { session_id: '--last' })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_path', id: piSessionPath })).toEqual({
      key: 'session_path',
      id: piSessionPath
    })
    expect(normalizeAgentProviderSession({ key: 'session_id', id: 'ok' })).toEqual({
      key: 'session_id',
      id: 'ok'
    })
  })
})
