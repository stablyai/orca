import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

afterEach(() => {
  vi.useRealTimers()
})

describe('sleepingAgentSessionsByPaneKey after reminted-hook settlement', () => {
  it('settles a live working record to done instead of latching at working', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      sleepingAgentSessionsByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'omp',
          providerSession: { key: 'session_id', id: 'omp-session-1' },
          prompt: 'finish the reminted pane',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live',
          terminalTitle: 'OMP ready'
        }
      }
    })

    store.getState().setAgentStatus(
      PANE,
      {
        state: 'working',
        prompt: 'finish the reminted pane',
        agentType: 'omp'
      },
      'OMP ready',
      { updatedAt: 2 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )
    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: 'finish the reminted pane',
        agentType: 'omp'
      },
      'OMP ready',
      { updatedAt: 3 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(store.getState().agentStatusByPaneKey[PANE]?.state).toBe('done')
    const sleeping = store.getState().sleepingAgentSessionsByPaneKey[PANE]
    expect(sleeping?.state === 'working' && sleeping.prompt === 'finish the reminted pane').toBe(
      false
    )
  })
})
