import { describe, expect, it } from 'vitest'

import type { AppState } from '../../types'
import './agent-status'
import { createTestStore } from '../store-test-helpers'
import { makeTab } from '../store-session-test-harness'

const PANE = 'tab-1:leaf-1'
const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }
const NOTE = { agentArgs: '--dangerously-skip-permissions --verbose', agentEnv: { K: 'v' } }

// Only the launch owner's statement changes a pane's note; an OSC update makes none.
describe("a pane's launch note across status updates", () => {
  it('survives an ordinary update after a turn and drops on a typed resume', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    const status = (state: 'working' | 'done', metadata: Record<string, unknown>) =>
      store
        .getState()
        .setAgentStatus(
          PANE,
          { state, prompt: 'task', agentType: 'claude' },
          'Claude',
          { updatedAt: Date.now(), stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession: SESSION, launchToken: 'launch-1', ...metadata }
        )
    const note = () => store.getState().sleepingAgentSessionsByPaneKey[PANE]?.launchConfig

    status('working', { launchConfig: NOTE })
    status('done', { launchConfig: NOTE })
    status('working', {})
    expect(note()).toEqual(NOTE)

    status('working', { launchConfig: null })
    store.getState().captureAllSleepingAgentSessions('quit')
    expect(note()).toBeUndefined()
  })
})
