import { describe, expect, it } from 'vitest'
import type { AgentMainAgentStatus } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree
} from './agent-status'
import { createTestStore, makeTab } from './store-test-helpers'
import { resolveAgentPaneDisplayState } from '../../../../shared/agent-status-display-state'

const PANE = 'tab-1:leaf-1'

// Auto-hibernation sleeps a pane only after a turn that ended cleanly: a failed or cancelled turn
// stays open so the user sees how it ended. Manual sleep is the user's own choice and still works.
function storeWithSettledPane(mainAgent: AgentMainAgentStatus | undefined) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  } as Partial<AppState>)
  store.getState().setAgentStatus(
    PANE,
    {
      state: 'done',
      prompt: 'finish the task',
      agentType: 'claude',
      ...(mainAgent ? { mainAgent } : {})
    },
    'Claude',
    { updatedAt: 10, stateStartedAt: 10 },
    { tabId: 'tab-1', worktreeId: 'wt-1' },
    { providerSession: { key: 'session_id', id: 'claude-session-1' } }
  )
  return store
}

const failed: AgentMainAgentStatus = { state: 'done', outcome: 'failure', stateStartedAt: 10 }
const cancelled: AgentMainAgentStatus = {
  state: 'done',
  outcome: 'cancellation',
  stateStartedAt: 10
}

describe('completed-agent hibernation reads only a clean turn ending', () => {
  it('captures and evidences a cleanly finished pane', () => {
    const state = storeWithSettledPane({ state: 'done', stateStartedAt: 10 }).getState()
    expect(
      collectSleepingAgentSessionRecordsForWorktree(state, 'wt-1', {
        captureMode: 'completed-agent-hibernation'
      })[PANE]
    ).toBeDefined()
    expect(collectHibernatedCompletionEvidenceForWorktree(state, 'wt-1', [PANE])).toHaveLength(1)
  })

  it.each([
    ['failed', failed],
    ['cancelled', cancelled]
  ])('neither captures nor evidences a %s pane', (_label, mainAgent) => {
    const state = storeWithSettledPane(mainAgent).getState()
    expect(
      collectSleepingAgentSessionRecordsForWorktree(state, 'wt-1', {
        captureMode: 'completed-agent-hibernation'
      })[PANE]
    ).toBeUndefined()
    expect(collectHibernatedCompletionEvidenceForWorktree(state, 'wt-1', [PANE])).toEqual([])
  })

  it('still captures a failed pane when the user sleeps the worktree, with no verdict on the record', () => {
    const state = storeWithSettledPane(failed).getState()
    const record = collectSleepingAgentSessionRecordsForWorktree(state, 'wt-1', {
      captureMode: 'manual-worktree-sleep'
    })[PANE]
    expect(record).toMatchObject({
      agent: 'claude',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
    expect(record).not.toHaveProperty('mainAgent')
    expect(record).not.toHaveProperty('outcome')
  })

  it('shows the resumed session as Done after a manual sleep and wake, never the old failure', () => {
    const store = storeWithSettledPane(failed)
    expect(resolveAgentPaneDisplayState(store.getState().agentStatusByPaneKey[PANE]!)).toBe(
      'failed'
    )
    // Waking starts a fresh provider process whose first report is an idle session boundary.
    store.getState().setAgentStatus(
      PANE,
      {
        state: 'done',
        prompt: '',
        agentType: 'claude',
        sessionBoundary: true,
        mainAgent: { state: 'done', stateStartedAt: 20 }
      },
      'Claude',
      { updatedAt: 20, stateStartedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )
    expect(resolveAgentPaneDisplayState(store.getState().agentStatusByPaneKey[PANE]!)).toBe('done')
  })
})
