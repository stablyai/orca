// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Repo, Worktree } from '../../../../shared/types'
import { collectRetainedAgentsOnDisappear, useRetainedAgentsSync } from './useRetainedAgents'

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
})

afterEach(() => {
  useAppStore.setState(initialAppState, true)
})

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  }
}

function makeWorktree(): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

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
  it('retains a clean done row when a different tab closed', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: { 'tab-2': true }
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
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {}
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
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {}
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
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {}
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
      retentionSuppressedPaneKeys: { 'tab-1:1': true },
      recentlyClosedAgentStatusTabIds: {}
    })

    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual(['tab-1:1'])
  })

  it('does not retain a done row after its tab closed without a live suppressor', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: { 'tab-1': true }
    })

    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual([])
  })
})

describe('useRetainedAgentsSync', () => {
  it('does not re-retain when status removal and tab closure commit before the next retention effect', async () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    const row = makeAgentRow({ paneKey, state: 'done' })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [row.tab] },
      agentStatusByPaneKey: { [row.paneKey]: row.entry },
      agentStatusEpoch: initialAppState.agentStatusEpoch + 1
    })
    const hook = renderHook(() => useRetainedAgentsSync())
    await act(async () => {
      await Promise.resolve()
    })
    expect(useAppStore.getState().retentionSuppressedPaneKeys[row.paneKey]).toBeUndefined()

    // Why: model both teardown writes landing before the next retention effect runs.
    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: { [worktree.id]: [] },
        agentStatusByPaneKey: {},
        recentlyClosedAgentStatusTabIds: { [row.tab.id]: true },
        agentStatusEpoch: state.agentStatusEpoch + 1
      }))
    })

    const state = useAppStore.getState()
    expect(state.recentlyClosedAgentStatusTabIds[row.tab.id]).toBe(true)
    expect(state.retainedAgentsByPaneKey[row.paneKey]).toBeUndefined()
    hook.unmount()
  })
})
