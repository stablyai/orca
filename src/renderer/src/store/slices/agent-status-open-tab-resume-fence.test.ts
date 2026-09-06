import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000
const PANE_KEY = 'tab-1:leaf-1'

function liveWorkerEntry(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'session-1' }
  }
}

// The worker settles while its tab is still open, so there is no sleeping record to stamp; the
// record is minted on close and used to arrive unfenced, respawning settled work on reopen.
describe('a resume fence that arrives before the sleeping record exists', () => {
  it('carries the block onto the record minted after the tab closes', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
      agentStatusByPaneKey: { [PANE_KEY]: liveWorkerEntry() }
    } as Partial<AppState>)

    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeUndefined()

    store.getState().captureAllSleepingAgentSessions('quit')

    expect(store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toMatchObject({
      paneKey: PANE_KEY,
      automaticResumeBlockedBy: 'legacy-orchestration-worker'
    })
  })

  it('mints an unfenced record once the runtime lifts the block', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
      agentStatusByPaneKey: { [PANE_KEY]: liveWorkerEntry() }
    } as Partial<AppState>)

    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    store.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false)
    store.getState().captureAllSleepingAgentSessions('quit')

    expect(
      store.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]?.automaticResumeBlockedBy
    ).toBeUndefined()
  })
})
