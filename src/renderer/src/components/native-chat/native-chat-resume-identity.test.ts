import { AgentStatusObservationSequencer } from '../../../../shared/agent-status-observation'
import { describe, expect, it } from 'vitest'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { applyProviderSessionOnlyUpdate } from '../../hooks/ipc-events/agent-status-partial-updates'
import { createAgentStatusPaneRoutingIndex } from '../../hooks/ipc-events/agent-status-pane-routing-index'
import type { AgentStatusBatchTransaction } from '../../store/slices/agent-status'
import { resolveNativeChatSession } from './native-chat-pane-resolution'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
const providerSession = {
  key: 'session_id' as const,
  id: 'resumed-session',
  transcriptPath: '/sessions/resumed-session.jsonl'
}

function restoredIdentity(): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'workspace-1',
    agent: 'codex',
    providerSession,
    prompt: '',
    state: 'working',
    capturedAt: 100,
    updatedAt: 100,
    origin: 'live'
  }
}

describe('native chat resume identity before the first turn hook', () => {
  it.each([false, true])(
    'reads a Codex identity-only replay without a live turn (batch=%s)',
    (batch) => {
      const store = createTestStore()
      const apply = (transaction?: AgentStatusBatchTransaction) =>
        applyProviderSessionOnlyUpdate({
          store: store.getState(),
          batch: transaction
            ? {
                transaction,
                routingIndex: createAgentStatusPaneRoutingIndex(store.getState()),
                projectedTitlesByTabId: new Map(),
                tabTitlesByTabId: new Map(),
                notificationEffects: []
              }
            : undefined,
          data: {
            connectionId: 'remote-1',
            paneKey,
            agentType: 'codex',
            state: 'working',
            prompt: '',
            receivedAt: 100,
            stateStartedAt: 100,
            providerSession,
            providerSessionOnly: true
          },
          paneKey,
          routing: { tabId: 'tab-1', worktreeId: 'workspace-1', connectionId: 'remote-1' }
        })
      expect(batch ? store.getState().transactAgentStatuses(apply) : apply()).toBe('applied')
      const state = store.getState()
      expect(state.agentStatusByPaneKey[paneKey]).toBeUndefined()
      expect(state.unreadAgentCompletionPanes[paneKey]).toBeUndefined()
      const resumeIdentity = state.sleepingAgentSessionsByPaneKey[paneKey]
      expect(resumeIdentity?.connectionId).toBe('remote-1')
      expect(
        resolveNativeChatSession({
          paneKey,
          launchAgent: 'codex',
          ptyId: 'pty-1',
          resumeIdentity
        })
      ).toMatchObject({
        sessionId: providerSession.id,
        transcriptPath: providerSession.transcriptPath
      })
    }
  )

  it.each([
    {
      origin: 'osc' as const,
      kind: 'snapshot' as const,
      connectionId: 'remote-1',
      worktreeId: 'workspace-1',
      expected: true
    },
    {
      origin: 'launch' as const,
      kind: 'transition' as const,
      connectionId: 'remote-1',
      worktreeId: 'workspace-1',
      expected: false
    },
    {
      origin: 'osc' as const,
      kind: 'snapshot' as const,
      connectionId: 'remote-2',
      worktreeId: 'workspace-1',
      expected: false
    },
    {
      origin: 'osc' as const,
      kind: 'snapshot' as const,
      connectionId: 'remote-1',
      worktreeId: 'workspace-2',
      expected: false
    }
  ])(
    'preserves resume identity before Chat mounts only for a matching OSC snapshot: %j',
    ({ origin, kind, connectionId, worktreeId, expected }) => {
      const store = createTestStore()
      store.getState().recordAgentProviderSession(
        paneKey,
        'codex',
        providerSession,
        { updatedAt: 100 },
        {
          tabId: 'tab-1',
          worktreeId: 'workspace-1',
          connectionId: 'remote-1'
        }
      )
      store.getState().setAgentStatus(
        paneKey,
        {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          observation: new AgentStatusObservationSequencer('renderer-test').observe(paneKey, {
            origin,
            kind,
            observedAt: 200
          })
        },
        'Codex',
        { updatedAt: 200 },
        { tabId: 'tab-1', worktreeId, connectionId }
      )
      const state = store.getState()
      expect(state.agentStatusByPaneKey[paneKey]?.providerSession).toEqual(
        expected ? providerSession : undefined
      )
      expect(
        resolveNativeChatSession({
          paneKey,
          ptyId: 'pty-1',
          launchAgent: 'codex',
          agentStatusEntry: state.agentStatusByPaneKey[paneKey],
          resumeIdentity: state.sleepingAgentSessionsByPaneKey[paneKey]
        })?.sessionId
      ).toBe(expected ? providerSession.id : null)
    }
  )

  it('does not reuse a previous session when a new live agent has not reported its identity', () => {
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'codex',
        ptyId: 'pty-1',
        resumeIdentity: restoredIdentity(),
        agentStatusEntry: {
          paneKey,
          agentType: 'codex',
          state: 'working',
          prompt: '',
          updatedAt: 200,
          stateStartedAt: 200,
          stateHistory: []
        }
      })?.sessionId
    ).toBeNull()
  })

  it.each([
    { paneKey: 'other-tab:other-leaf' },
    { agent: 'claude' as const },
    { origin: 'worktree-sleep' as const }
  ])('does not read an unrelated or sleeping identity: %j', (override) => {
    expect(
      resolveNativeChatSession({
        paneKey,
        launchAgent: 'codex',
        ptyId: 'pty-1',
        resumeIdentity: { ...restoredIdentity(), ...override }
      })?.sessionId
    ).toBeNull()
  })
})
