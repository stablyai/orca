import { describe, expect, it } from 'vitest'
import {
  agentProviderSessionsEqual,
  extractAgentProviderSession,
  getAgentResumeArgv,
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from './agent-session-resume'

describe('agent session resume metadata', () => {
  it('treats devin as a resumable TUI agent', () => {
    expect(isResumableTuiAgent('devin')).toBe(true)
  })

  it('treats omp as a resumable TUI agent', () => {
    expect(isResumableTuiAgent('omp')).toBe(true)
  })

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
    [
      'pi',
      { session_id: 'pi-session', session_file: '/tmp/pi-session.jsonl' },
      { key: 'session_id', id: 'pi-session', transcriptPath: '/tmp/pi-session.jsonl' }
    ],
    ['mimo-code', { sessionID: 'mimo-session' }, { key: 'session_id', id: 'mimo-session' }],
    ['droid', { session_id: 'droid-session' }, { key: 'session_id', id: 'droid-session' }],
    ['grok', { sessionId: 'grok-session' }, { key: 'session_id', id: 'grok-session' }],
    ['devin', { session_id: 'devin-session' }, { key: 'session_id', id: 'devin-session' }],
    ['omp', { session_id: 'omp-session' }, { key: 'session_id', id: 'omp-session' }]
  ] as const)('extracts %s provider session ids', (source, payload, expected) => {
    expect(extractAgentProviderSession(source, payload)).toEqual(expected)
  })

  it.each([
    ['claude', { key: 'session_id', id: 's1' }, ['claude', '--resume', 's1']],
    ['codex', { key: 'session_id', id: 's1' }, ['codex', 'resume', 's1']],
    ['gemini', { key: 'session_id', id: 's1' }, ['gemini', '--resume', 's1']],
    ['antigravity', { key: 'conversation_id', id: 's1' }, ['agy', '--conversation', 's1']],
    ['opencode', { key: 'session_id', id: 's1' }, ['opencode', '--session', 's1']],
    [
      'pi',
      { key: 'session_id', id: 's1', transcriptPath: '/tmp/pi-session.jsonl' },
      ['pi', '--session', '/tmp/pi-session.jsonl']
    ],
    ['mimo-code', { key: 'session_id', id: 's1' }, ['mimo', '--session', 's1']],
    ['droid', { key: 'session_id', id: 's1' }, ['droid', '--resume', 's1']],
    ['grok', { key: 'session_id', id: 's1' }, ['grok', '--resume', 's1']],
    ['devin', { key: 'session_id', id: 'abc12345' }, ['devin', '--resume', 'abc12345']],
    ['omp', { key: 'session_id', id: 's1' }, ['omp', '--resume', 's1']]
  ] as const)('builds %s resume argv', (agent, providerSession, expected) => {
    expect(getAgentResumeArgv(agent, providerSession)).toEqual(expected)
  })

  it('rejects unsupported sources and unsafe ids', () => {
    expect(extractAgentProviderSession('cursor', { session_id: 'cursor-session' })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_id', id: 'bad\nid' })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_id', id: '--last' })).toBeNull()
    expect(extractAgentProviderSession('codex', { session_id: '--last' })).toBeNull()
    expect(normalizeAgentProviderSession({ key: 'session_id', id: 'ok' })).toEqual({
      key: 'session_id',
      id: 'ok'
    })
  })

  it('does not capture ephemeral Pi sessions without a session file', () => {
    expect(extractAgentProviderSession('pi', { session_id: 'pi-session' })).toBeNull()
    expect(
      extractAgentProviderSession('pi', { session_id: 'pi-session', session_file: '' })
    ).toBeNull()
    expect(extractAgentProviderSession('pi', { session_file: '/tmp/pi-session.jsonl' })).toBeNull()
    expect(getAgentResumeArgv('pi', { key: 'session_id', id: 'pi-session' })).toBeNull()
  })

  it('compares the actual provider resume locator for each agent', () => {
    const first = { key: 'session_id' as const, id: 'session-1', transcriptPath: '/tmp/first' }
    const second = { key: 'session_id' as const, id: 'session-1', transcriptPath: '/tmp/second' }

    expect(agentProviderSessionsEqual('pi', first, second)).toBe(false)
    expect(agentProviderSessionsEqual('claude', first, second)).toBe(true)
  })

  it('rejects devin resume when provider session key is not session_id', () => {
    expect(getAgentResumeArgv('devin', { key: 'conversation_id', id: 'x' })).toBeNull()
  })

  it('captures the hook transcript_path for native-chat agents (claude/codex)', () => {
    expect(
      extractAgentProviderSession('claude', {
        session_id: 'cs',
        transcript_path: '/home/u/.claude/projects/slug/real.jsonl'
      })
    ).toEqual({
      key: 'session_id',
      id: 'cs',
      transcriptPath: '/home/u/.claude/projects/slug/real.jsonl'
    })
    expect(
      extractAgentProviderSession('codex', { session_id: 'xs', transcriptPath: '/x/r.jsonl' })
    ).toEqual({ key: 'session_id', id: 'xs', transcriptPath: '/x/r.jsonl' })
  })

  it('does not attach transcript_path for non-native-chat agents', () => {
    expect(
      extractAgentProviderSession('gemini', { session_id: 'gs', transcript_path: '/x/r.jsonl' })
    ).toEqual({ key: 'session_id', id: 'gs' })
  })

  it('round-trips transcriptPath through normalizeAgentProviderSession', () => {
    expect(
      normalizeAgentProviderSession({ key: 'session_id', id: 'ok', transcriptPath: '/x/r.jsonl' })
    ).toEqual({ key: 'session_id', id: 'ok', transcriptPath: '/x/r.jsonl' })
    expect(
      normalizeAgentProviderSession({
        key: 'session_id',
        id: 'ok',
        transcriptPath: '/tmp/bad\npath.jsonl'
      })
    ).toEqual({ key: 'session_id', id: 'ok' })
  })
})
