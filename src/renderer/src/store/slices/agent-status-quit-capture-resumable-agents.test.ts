import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('quit-time capture for newly resumable agents', () => {
  it.each([
    {
      agent: 'kimi',
      displayName: 'Kimi',
      sessionId: 'session_431324d7-2165-42f0-9ecd-9f93437b3201',
      issue: '#15155'
    },
    {
      agent: 'cursor',
      displayName: 'Cursor Agent',
      sessionId: '668320d2-2fd8-4888-b33c-2a466fec86e7',
      issue: '#18668'
    }
  ] as const)(
    'checkpoints a live $agent provider session before quit-time capture ($issue)',
    ({ agent, displayName, sessionId }) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
        }
      } as Partial<AppState>)

      store.getState().setAgentStatus(
        'tab-1:leaf-1',
        {
          state: 'working',
          prompt: 'finish the task',
          agentType: agent
        },
        displayName,
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        {
          providerSession: {
            key: 'session_id',
            id: sessionId
          }
        }
      )

      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        agent,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        providerSession: { key: 'session_id', id: sessionId },
        origin: 'live'
      })
    }
  )
})
