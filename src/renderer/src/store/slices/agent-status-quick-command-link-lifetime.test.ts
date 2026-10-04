import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

const PANE = 'tab-1:leaf-1'
const IDENTITY = { launchToken: 'launch-token-1', tabId: 'tab-1', leafId: 'leaf-1' }

function reportClaudeSession(store: ReturnType<typeof createTestStore>, sessionId: string): void {
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'task', agentType: 'claude' },
      'Claude',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: sessionId }, launchToken: 'launch-token-1' }
    )
}

describe('Quick Command link lifetime in a pane', () => {
  it('links only the session the Quick Command launched, not a later one in the pane', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    })
    store
      .getState()
      .registerAgentLaunchConfig(
        PANE,
        { agentArgs: '', agentEnv: {}, quickCommandId: 'qc-muse', quickCommandLabel: 'muse' },
        IDENTITY
      )
    reportClaudeSession(store, 'session-muse')
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]).toMatchObject({
      providerSession: { id: 'session-muse' },
      quickCommandId: 'qc-muse'
    })

    // Why: a different agent/preset started later in the same pane must not
    // resume through the first wrapper — the launch token is consumed, so the
    // new session falls back to the stock command.
    reportClaudeSession(store, 'session-later')
    const record = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(record?.providerSession.id).toBe('session-later')
    expect(record?.quickCommandId).toBeUndefined()
  })
})
