import { expect, it } from 'vitest'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

it('recovers the exact local Claude pane and skips other panes, providers, and remote records', () => {
  const saved: SleepingAgentSessionRecord = {
    paneKey: 'tab:leaf',
    worktreeId: 'workspace',
    origin: 'live',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'saved', transcriptPath: '/tmp/session.jsonl' },
    state: 'working',
    capturedAt: 1,
    updatedAt: 2,
    prompt: ''
  }
  const input = { paneKey: saved.paneKey, ptyId: 'pty', saved }
  expect(resolveNativeChatSession(input)).toMatchObject({
    agent: 'claude',
    sessionId: 'saved',
    transcriptPath: '/tmp/session.jsonl'
  })
  const previous = resolveNativeChatSession(input)
  const replacement = { ...input, ptyId: 'new-pty' }
  const pending = resolveNativeChatSession(replacement, previous)
  expect(pending?.sessionId).toBeNull()
  expect(resolveNativeChatSession(replacement, pending)?.sessionId).toBeNull()
  expect(
    resolveNativeChatSession({ ...replacement, restoredPtyId: 'pty' }, pending)?.sessionId
  ).toBeNull()
  expect(
    resolveNativeChatSession({ ...replacement, restoredPtyId: 'new-pty' }, pending)?.sessionId
  ).toBe('saved')
  expect(
    resolveNativeChatSession({
      ...input,
      agentStatusEntry: {
        paneKey: saved.paneKey,
        state: 'working',
        stateStartedAt: 3,
        updatedAt: 4,
        prompt: '',
        stateHistory: [],
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'new-session' }
      }
    })
  ).toMatchObject({ sessionId: 'new-session', transcriptPath: null })
  expect(
    resolveNativeChatSession({ ...input, saved: { ...saved, origin: 'worktree-sleep' } })
  ).toBeNull()
  expect(resolveNativeChatSession({ ...input, paneKey: 'tab:other' })).toBeNull()
  expect(
    resolveNativeChatSession({ ...input, saved: { ...saved, connectionId: 'remote' } })
  ).toBeNull()
  expect(resolveNativeChatSession({ ...input, resolvedAgent: 'codex' })).toMatchObject({
    agent: 'codex',
    sessionId: null
  })
})
