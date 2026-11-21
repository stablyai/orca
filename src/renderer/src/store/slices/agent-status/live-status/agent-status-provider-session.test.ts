import { expect, it } from 'vitest'
import { createTestStore } from '../../../testing/app-store-test-fixture'

it('replaces only the captured pane resume handle and keeps a newer session through manual sleep', () => {
  const store = createTestStore()
  const paneKey = 'tab-1:leaf-1'
  const captured = {
    paneKey,
    worktreeId: 'wt-1',
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'old' },
    prompt: '',
    state: 'done' as const,
    origin: 'live' as const,
    capturedAt: 1,
    updatedAt: 1
  }
  store.getState().rememberSleepingAgentSession(captured)
  const resumed = { ...captured, origin: 'quit' as const, restoreOnTabOpenOnly: true }
  store.getState().rememberSleepingAgentSession(resumed, captured)
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(resumed)
  const newer = { ...resumed, providerSession: { ...captured.providerSession, id: 'new' } }
  store.getState().rememberSleepingAgentSession(newer, resumed)
  store.getState().rememberSleepingAgentSession(resumed, captured)
  store.getState().captureSleepingAgentSessionsByWorktree('wt-1')
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBe(newer)
  store.getState().clearSleepingAgentSession(paneKey)
  store.getState().rememberSleepingAgentSession(resumed, newer)
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
})

it('drops a host-assigned agent id when a failed commit leaves a new Pi transcript unnamed', () => {
  const store = createTestStore()
  const paneKey = 'tab-1:leaf-1'
  const report = (updatedAt: number, transcriptPath: string, orcaSessionId?: string) =>
    store.getState().setAgentStatus(
      paneKey,
      { state: 'working', agentType: 'pi', prompt: 'p' },
      undefined,
      { updatedAt, stateStartedAt: updatedAt },
      { worktreeId: 'wt-1' },
      {
        providerSession: { key: 'session_id', id: 'P', transcriptPath },
        ...(orcaSessionId ? { orcaSessionId } : {})
      }
    )
  report(1_000, '/a.jsonl', 'pi_identity_one')
  expect(store.getState().agentStatusByPaneKey.get(paneKey)?.orcaSessionId).toBe('pi_identity_one')
  report(2_000, '/b.jsonl')
  expect(store.getState().agentStatusByPaneKey.get(paneKey)?.orcaSessionId).toBeUndefined()
})
