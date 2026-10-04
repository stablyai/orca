import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

describe('Cursor quit checkpoint', () => {
  it.each(['working', 'done'] as const)(
    'retains the same %s conversation in a folder workspace',
    (state) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: { 'folder-1': [makeTab({ id: 'tab-1', worktreeId: 'folder-1' })] }
      })
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'remember the codeword', agentType: 'cursor' },
          'Cursor',
          { updatedAt: 10, stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'folder-1' },
          { providerSession: { key: 'conversation_id', id: 'conversation-742' } }
        )
      if (state === 'done') {
        store.getState().setAgentStatus('tab-1:leaf-1', {
          state,
          prompt: 'remember the codeword',
          agentType: 'cursor'
        })
      }
      store.getState().captureAllSleepingAgentSessions('quit')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        agent: 'cursor',
        state,
        worktreeId: 'folder-1',
        providerSession: { key: 'conversation_id', id: 'conversation-742' },
        origin: state === 'done' ? 'live' : 'quit'
      })
    }
  )
})
