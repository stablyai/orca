import { expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'

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

it.each([
  { incomingId: 'root-b', connectionId: 'ssh-a', keepsTurn: false },
  { incomingId: 'root-a', connectionId: 'ssh-b', keepsTurn: false },
  { incomingId: 'root-a', connectionId: undefined, keepsTurn: true },
  { incomingId: undefined, connectionId: undefined, keepsTurn: true }
])(
  'scopes clockless Codex turn facts to their root: %j',
  ({ incomingId, connectionId, keepsTurn }) => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-1'
    store.getState().setAgentStatus(
      paneKey,
      { state: 'done', agentType: 'codex', prompt: 'first', sessionBoundary: true },
      undefined,
      {
        updatedAt: 2_000,
        stateStartedAt: 2_000,
        turnStartedAt: 1_000,
        turnEndedAt: 2_000,
        turnEndDisposition: 'identified'
      },
      { connectionId: 'ssh-a', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'root-a' } }
    )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'codex', prompt: '', sessionBoundary: true },
        undefined,
        { updatedAt: 3_000, stateStartedAt: 3_000 },
        connectionId === undefined ? undefined : { connectionId, worktreeId: 'wt-1' },
        incomingId === undefined
          ? undefined
          : { providerSession: { key: 'session_id', id: incomingId } }
      )
    const row = store.getState().agentStatusByPaneKey[paneKey]
    if (keepsTurn) {
      expect(row).toMatchObject({
        turnStartedAt: 1_000,
        turnEndedAt: 2_000,
        turnEndDisposition: 'identified'
      })
    } else {
      expect(row?.turnStartedAt).toBeUndefined()
      expect(row?.turnEndedAt).toBeUndefined()
      expect(row?.turnEndDisposition).toBeUndefined()
    }
    store.getState().setAgentStatus(
      paneKey,
      { state: 'done', agentType: 'codex', prompt: 'next', sessionBoundary: true },
      undefined,
      {
        updatedAt: 5_000,
        stateStartedAt: 5_000,
        turnStartedAt: 4_000,
        turnEndedAt: 5_000,
        turnEndDisposition: 'identified'
      },
      undefined,
      { providerSession: { key: 'session_id', id: 'root-c' } }
    )
    expect(store.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
      turnStartedAt: 4_000,
      turnEndedAt: 5_000,
      turnEndDisposition: 'identified'
    })
  }
)
