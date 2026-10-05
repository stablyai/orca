import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

const PANE_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const PANE_B = 'tab-1:22222222-2222-4222-8222-222222222222'
const OTHER_TAB_PANE = 'tab-2:11111111-1111-4111-8111-111111111111'
const NO_SESSION_PANE = 'tab-3:11111111-1111-4111-8111-111111111111'
const TRANSCRIPT = '/p/693d.jsonl'

function claudeParent(paneKey: string): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'Parent',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 's1', transcriptPath: TRANSCRIPT }
  }
}

describe('pane subagent views', () => {
  beforeEach(() => {
    useAppStore.setState({
      paneSubagentViewByPaneKey: {},
      agentStatusByPaneKey: {
        [PANE_A]: claudeParent(PANE_A),
        [PANE_B]: claudeParent(PANE_B),
        [OTHER_TAB_PANE]: claudeParent(OTHER_TAB_PANE)
      }
    })
  })

  it('pins a shown subagent to the session it belongs to, and returns the pane to its main agent', () => {
    useAppStore.getState().showPaneSubagent(PANE_A, { agentId: 'a1', name: 'Explore' })
    expect(useAppStore.getState().paneSubagentViewByPaneKey[PANE_A]).toEqual({
      agentId: 'a1',
      name: 'Explore',
      parentTranscriptPath: TRANSCRIPT
    })

    useAppStore.getState().showPaneMainAgent(PANE_A)
    expect(useAppStore.getState().paneSubagentViewByPaneKey).toEqual({})
  })

  it('shows nothing for a pane whose agent reports no session transcript', () => {
    useAppStore.getState().showPaneSubagent(NO_SESSION_PANE, { agentId: 'a1', name: 'Explore' })
    expect(useAppStore.getState().paneSubagentViewByPaneKey).toEqual({})
  })

  it('keeps the same state when a pane already shows its main agent', () => {
    const before = useAppStore.getState().paneSubagentViewByPaneKey
    useAppStore.getState().showPaneMainAgent(PANE_A)
    expect(useAppStore.getState().paneSubagentViewByPaneKey).toBe(before)
  })

  it("returns every pane of one tab to its main agent, and only that tab's", () => {
    const store = useAppStore.getState()
    store.showPaneSubagent(PANE_A, { agentId: 'a1', name: 'Explore' })
    store.showPaneSubagent(PANE_B, { agentId: 'a2', name: 'Plan' })
    store.showPaneSubagent(OTHER_TAB_PANE, { agentId: 'a1', name: 'Explore' })

    useAppStore.getState().showTabMainAgents('tab-1')
    expect(Object.keys(useAppStore.getState().paneSubagentViewByPaneKey)).toEqual([OTHER_TAB_PANE])
  })
})
