import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { collectRetainedAgentsOnDisappear } from './useRetainedAgents'

function makeAgentRow(args: { paneKey: string; state: AgentStatusState; interrupted?: boolean }) {
  const entry: AgentStatusEntry = {
    state: args.state,
    prompt: 'Fix it',
    updatedAt: 100,
    stateStartedAt: 100,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: args.interrupted
  }

  return {
    paneKey: args.paneKey,
    entry,
    tab: {
      id: 'tab-1',
      worktreeId: 'wt-1',
      title: 'Terminal',
      ptyId: null,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    agentType: 'claude' as const,
    state: args.state,
    startedAt: 1
  }
}

describe('collectRetainedAgentsOnDisappear', () => {
  it('retains a clean done row that disappeared naturally', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toHaveLength(1)
    expect(result.toRetain[0]?.entry.paneKey).toBe('tab-1:1')
    expect(result.consumedSuppressedPaneKeys).toEqual([])
  })

  it('does not retain an interrupted done row', () => {
    const previousAgents = new Map([
      [
        'tab-1:1',
        {
          row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done', interrupted: true }),
          worktreeId: 'wt-1'
        }
      ]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toEqual([])
  })

  it('refreshes the retained snapshot when a reused paneKey starts a newer run', () => {
    // Why: a reused paneKey (same tab+pane, fresh agent start after a prior
    // retained run) produces a newer startedAt. Without the freshness check
    // the loop would early-continue because retainedAgentsByPaneKey[paneKey]
    // is still truthy from the prior run — leaving stale completion data
    // visible forever for the reused pane.
    const prevRow = makeAgentRow({ paneKey: 'tab-1:1', state: 'done' })
    prevRow.startedAt = 200
    const previousAgents = new Map([['tab-1:1', { row: prevRow, worktreeId: 'wt-1' }]])

    const staleRetained = {
      entry: { ...prevRow.entry, updatedAt: 50, stateStartedAt: 50 },
      worktreeId: 'wt-1',
      tab: prevRow.tab,
      agentType: 'claude' as const,
      startedAt: 100
    }

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: { 'tab-1:1': staleRetained },
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toHaveLength(1)
    expect(result.toRetain[0]?.startedAt).toBe(200)
  })

  it('does not re-retain when the existing retained snapshot is for the same run', () => {
    const prevRow = makeAgentRow({ paneKey: 'tab-1:1', state: 'done' })
    prevRow.startedAt = 100
    const previousAgents = new Map([['tab-1:1', { row: prevRow, worktreeId: 'wt-1' }]])

    const sameRunRetained = {
      entry: prevRow.entry,
      worktreeId: 'wt-1',
      tab: prevRow.tab,
      agentType: 'claude' as const,
      startedAt: 100
    }

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: { 'tab-1:1': sameRunRetained },
      retentionSuppressedPaneKeys: {}
    })

    expect(result.toRetain).toEqual([])
  })

  it('does not retain a clean done row when teardown suppressed that pane', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: { 'tab-1:1': true }
    })

    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual(['tab-1:1'])
  })
})
