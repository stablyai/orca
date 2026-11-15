import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { selectLiveAgentStatusEntriesForWorktree } from './worktree-agent-row-selectors'

const PANE_KEY_1 = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')

function makeEntry(
  paneKey: string,
  startedAt: number,
  overrides?: Partial<AgentStatusEntry>
): AgentStatusEntry {
  return {
    paneKey,
    state: 'done',
    stateStartedAt: startedAt,
    updatedAt: startedAt,
    stateHistory: [],
    prompt: 'finished prompt',
    agentType: 'claude',
    terminalTitle: undefined,
    interrupted: false,
    ...overrides
  }
}

it('reads a new live agent after the last row was removed without an intervening read', () => {
  const store = createTestStore()
  const first = makeEntry(PANE_KEY_1, 1000, { state: 'working', worktreeId: 'wt-1' })
  store.setState({ agentStatusByPaneKey: acceptedAgentStatuses([[PANE_KEY_1, first]]) })
  expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([first])
  store.getState().removeAgentStatus(PANE_KEY_1)
  const second = makeEntry('tab-2:33333333-3333-4333-8333-333333333333', 1001, {
    state: 'working',
    worktreeId: 'wt-1',
    prompt: 'new task'
  })
  store.setState({
    agentStatusByPaneKey: store.getState().agentStatusByPaneKey.replace([[second.paneKey, second]])
  })
  expect(selectLiveAgentStatusEntriesForWorktree(store.getState(), 'wt-1')).toEqual([second])
})
