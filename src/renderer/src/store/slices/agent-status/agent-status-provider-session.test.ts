import { expect, it } from 'vitest'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { canPaneOfferAgentId } from '../../../lib/agent-session/identity/pane-agent-session-id'

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
    const row = store.getState().agentStatusByPaneKey.get(paneKey)
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
    expect(store.getState().agentStatusByPaneKey.get(paneKey)).toMatchObject({
      turnStartedAt: 4_000,
      turnEndedAt: 5_000,
      turnEndDisposition: 'identified'
    })
  }
)

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

it('offers Copy Agent ID wherever the host stamped the field, even before it named the agent', () => {
  const store = createTestStore()
  const paneKey = 'tab-1:leaf-1'
  const report = (updatedAt: number, orcaSessionId?: string | null) =>
    store.getState().setAgentStatus(
      paneKey,
      { state: 'working', agentType: 'claude', prompt: 'p' },
      undefined,
      { updatedAt, stateStartedAt: updatedAt },
      { worktreeId: 'wt-1' },
      {
        providerSession: { key: 'session_id', id: 'S' },
        ...(orcaSessionId !== undefined ? { orcaSessionId } : {})
      }
    )
  const offered = () => canPaneOfferAgentId(store.getState(), paneKey, () => true)
  // An older host never stamps it: nothing there could answer the click.
  report(1_000)
  expect(offered()).toBe(false)
  // A current host whose first link failed stamps null: the click retries on that host.
  report(2_000, null)
  expect(offered()).toBe(true)
  // A local ID-less update (OSC/title) keeps the host's stamp for the same conversation.
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { state: 'working', agentType: 'claude', prompt: 'p' },
      undefined,
      { updatedAt: 2_500, stateStartedAt: 2_000 },
      { worktreeId: 'wt-1' }
    )
  expect(offered()).toBe(true)
  // The host's own answer that it cannot name it (a read-only miss) clears the pending null.
  report(2_700)
  expect(offered()).toBe(false)
  report(3_000, 'claude_identity')
  expect(offered()).toBe(true)
})
