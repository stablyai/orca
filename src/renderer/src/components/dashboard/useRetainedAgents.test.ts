// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorktreeAgentRows } from '../sidebar/worktree-agent-rows'
import { useAppStore } from '@/store'
import { resetAgentPaneAuthorityAliasesForTests } from '@/store/slices/agent-pane-authority'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  ENV,
  LEAF_ID,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildRetainedAgentsSyncSnapshot,
  collectRetainedAgentsOnDisappear,
  useRetainedAgentsSync
} from './useRetainedAgents'

const initialAppState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  resetAgentPaneAuthorityAliasesForTests()
})

afterEach(() => {
  useAppStore.setState(initialAppState, true)
  resetAgentPaneAuthorityAliasesForTests()
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

function makeWorktree(overrides?: Partial<Worktree>): Worktree {
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
    lastActivityAt: 1,
    ...overrides
  }
}

function makeTab(overrides: Partial<TerminalTab> & { id: string }): TerminalTab {
  return {
    worktreeId: 'wt-1',
    title: 'Terminal',
    ptyId: null,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function makeAgentRow(args: {
  paneKey: string
  state: AgentStatusState
  interrupted?: boolean
  mainAgent?: AgentStatusEntry['mainAgent']
}) {
  const entry: AgentStatusEntry = {
    state: args.state,
    prompt: 'Fix it',
    updatedAt: 100,
    stateStartedAt: 100,
    paneKey: args.paneKey,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: 'claude',
    interrupted: args.interrupted,
    mainAgent: args.mainAgent
  }

  return {
    paneKey: args.paneKey,
    entry,
    tab: makeTab({ id: 'tab-1' }),
    agentType: 'claude' as const,
    state: args.state,
    startedAt: 1
  }
}

describe('collectRetainedAgentsOnDisappear', () => {
  it('carries paired retained order through same-session return and resets known replacement', () => {
    resetWebSessionTabsSyncTestState()
    useAppStore.setState({
      repos: [makeRepo()],
      worktreesByRepo: { 'repo-1': [makeWorktree({ id: WT })] }
    })
    const entry: AgentStatusEntry = {
      ...makeAgentRow({ paneKey: makePaneKey('host-tab-1', LEAF_ID), state: 'done' }).entry,
      worktreeId: WT,
      providerSession: { key: 'session_id', id: 'A' }
    }
    const quiet: AgentStatusEntry = {
      ...entry,
      paneKey: makePaneKey('host-tab-2', LEAF_ID),
      state: 'working',
      updatedAt: 2000,
      stateStartedAt: 2000,
      providerSession: { key: 'session_id', id: 'quiet' }
    }
    const update = (agentStatus: AgentStatusEntry | undefined, version: number) => {
      const tabs = [agentStatus, quiet].map((status, index) => ({
        type: 'terminal' as const,
        id: `host-tab-${index + 1}::${LEAF_ID}`,
        title: 'Claude',
        parentTabId: `host-tab-${index + 1}`,
        leafId: LEAF_ID,
        isActive: index === 0,
        status: 'ready' as const,
        terminal: `terminal-${index + 1}`,
        agentStatus: status
      }))
      useAppStore.setState(
        applyWebSessionTabsSnapshot(
          useAppStore.getState(),
          makeSnapshot(tabs, { snapshotVersion: version }),
          ENV,
          1_000_000 + version
        )
      )
    }
    const snapshot = () =>
      buildRetainedAgentsSyncSnapshot({
        repos: [makeRepo()],
        worktreesByRepo: { 'repo-1': [makeWorktree({ id: WT })] },
        folderWorkspaces: [],
        tabsByWorktree: useAppStore.getState().tabsByWorktree,
        agentStatusByPaneKey: useAppStore.getState().agentStatusByPaneKey,
        now: 1_000_000
      })
    const rows = () =>
      buildWorktreeAgentRows({
        tabs: useAppStore.getState().tabsByWorktree[WT] ?? [],
        entries: Object.values(useAppStore.getState().agentStatusByPaneKey),
        retained: Object.values(useAppStore.getState().retainedAgentsByPaneKey),
        now: 1_000_000
      })
    update({ ...entry, updatedAt: 1000, stateStartedAt: 1000, state: 'working' }, 1)
    update({ ...entry, updatedAt: 5000, stateStartedAt: 5000 }, 2)
    const previous = snapshot()
    update(undefined, 3)
    const current = snapshot()
    const result = collectRetainedAgentsOnDisappear({
      previousAgents: previous.currentAgents,
      currentAgents: current.currentAgents,
      retainedAgentsByPaneKey: useAppStore.getState().retainedAgentsByPaneKey,
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {},
      tabIndex: current.tabIndex
    })
    expect(result.toRetain).toHaveLength(1)
    useAppStore.getState().retainAgents(result.toRetain)
    expect(rows().map((row) => row.startedAt)).toEqual([1000, 2000])
    update({ ...entry, updatedAt: 6000, stateStartedAt: 6000, state: 'working' }, 4)
    expect(rows().map((row) => row.entry.providerSession?.id)).toEqual(['A', 'quiet'])
    expect(rows().map((row) => row.startedAt)).toEqual([1000, 2000])
    update(undefined, 5)
    update(
      {
        ...entry,
        updatedAt: 7000,
        stateStartedAt: 6000,
        state: 'working',
        providerSession: { key: 'session_id', id: 'B' }
      },
      6
    )
    expect(rows().map((row) => row.entry.providerSession?.id)).toEqual(['quiet', 'B'])
    expect(rows().map((row) => row.startedAt)).toEqual([2000, 7000])
  })

  it('retains a clean done row when a different tab closed', () => {
    const previousAgents = new Map([
      ['tab-1:1', { row: makeAgentRow({ paneKey: 'tab-1:1', state: 'done' }), worktreeId: 'wt-1' }]
    ])

    const result = collectRetainedAgentsOnDisappear({
      previousAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: { 'tab-2': true },
      recentlyRetiredAgentStatusPaneKeys: {}
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
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
    })

    expect(result.toRetain).toEqual([])
  })

  it('retains a failed done row so the failure stays visible, but not a cancelled one', () => {
    const retainedFor = (outcome: 'failure' | 'cancellation') =>
      collectRetainedAgentsOnDisappear({
        previousAgents: new Map([
          [
            'tab-1:1',
            {
              row: makeAgentRow({
                paneKey: 'tab-1:1',
                state: 'done',
                mainAgent: { state: 'done', outcome, stateStartedAt: 100 }
              }),
              worktreeId: 'wt-1'
            }
          ]
        ]),
        currentAgents: new Map(),
        retainedAgentsByPaneKey: {},
        retentionSuppressedPaneKeys: {},
        recentlyClosedAgentStatusTabIds: {},
        recentlyRetiredAgentStatusPaneKeys: {}
      }).toRetain

    expect(retainedFor('failure')).toHaveLength(1)
    expect(retainedFor('failure')[0]?.entry.mainAgent?.outcome).toBe('failure')
    expect(retainedFor('cancellation')).toEqual([])
  })

  it('refreshes the retained snapshot when a reused paneKey starts a newer run', () => {
    // Reused pane keys can start newer runs; replace older retained completion snapshots instead of skipping a truthy key.
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
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
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
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
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
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
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
      recentlyClosedAgentStatusTabIds: { 'tab-1': true },
      recentlyRetiredAgentStatusPaneKeys: {}
    })

    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual([])
  })
})

describe('useRetainedAgentsSync', () => {
  it('does not build a fleet snapshot for a title-only publication across 300 worktrees', async () => {
    const repo = makeRepo()
    const worktrees = Array.from({ length: 300 }, (_, index) =>
      makeWorktree({ id: `wt-${index}`, path: `/repo/wt-${index}` })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id, title: `Title ${index}` })]
      ])
    )
    const retainAgents = vi.fn()
    const pruneRetainedAgents = vi.fn()
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: worktrees },
      tabsByWorktree,
      retainAgents,
      pruneRetainedAgents
    })
    const hook = renderHook(() => useRetainedAgentsSync())
    await act(async () => {
      await Promise.resolve()
    })
    retainAgents.mockClear()
    pruneRetainedAgents.mockClear()

    const changedWorktreeId = 'wt-173'
    act(() => {
      useAppStore.setState({
        tabsByWorktree: {
          ...tabsByWorktree,
          [changedWorktreeId]: [
            {
              ...tabsByWorktree[changedWorktreeId][0],
              title: 'Updated display title'
            }
          ]
        }
      })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(retainAgents).not.toHaveBeenCalled()
    expect(pruneRetainedAgents).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('uses the freshest tab title when a real agent transition retains a completed row', async () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    const row = makeAgentRow({ paneKey, state: 'done' })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: {
        [worktree.id]: [{ ...row.tab, title: '⠋ Codex is thinking' }]
      },
      agentStatusByPaneKey: { [paneKey]: row.entry },
      agentStatusEpoch: initialAppState.agentStatusEpoch + 1
    })
    const hook = renderHook(() => useRetainedAgentsSync())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          [worktree.id]: [
            {
              ...state.tabsByWorktree[worktree.id][0],
              title: '⠙ Codex is thinking'
            }
          ]
        }
      }))
    })
    act(() => {
      useAppStore.setState((state) => ({
        agentStatusByPaneKey: {},
        agentStatusEpoch: state.agentStatusEpoch + 1
      }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(useAppStore.getState().retainedAgentsByPaneKey[paneKey]?.tab.title).toBe(
      '⠙ Codex is thinking'
    )
    hook.unmount()
  })

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

  it('does not leave a ghost row when a done pane detaches into another tab', async () => {
    const repo = makeRepo()
    const worktree = makeWorktree()
    const leafId = '11111111-1111-4111-8111-111111111111'
    const sourceTab = makeTab({ id: 'tab-source', ptyId: 'pty-a' })
    const targetTab = makeTab({ id: 'tab-target' })
    const sourcePaneKey = makePaneKey(sourceTab.id, leafId)
    const targetPaneKey = makePaneKey(targetTab.id, leafId)
    const row = makeAgentRow({ paneKey: sourcePaneKey, state: 'done' })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [sourceTab, targetTab] },
      ptyIdsByTabId: { [sourceTab.id]: ['pty-a'], [targetTab.id]: [] },
      agentStatusByPaneKey: { [sourcePaneKey]: { ...row.entry, tabId: sourceTab.id } },
      agentStatusEpoch: initialAppState.agentStatusEpoch + 1
    })
    const hook = renderHook(() => useRetainedAgentsSync())
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      useAppStore.getState().syncPaneDetachPtyOwnership({
        detachedLeafId: leafId,
        detachedPtyId: 'pty-a',
        sourceLayout: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        },
        sourceTabId: sourceTab.id,
        targetTabId: targetTab.id
      })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const state = useAppStore.getState()
    expect(state.agentStatusByPaneKey[targetPaneKey]?.state).toBe('done')
    expect(state.retainedAgentsByPaneKey[sourcePaneKey]).toBeUndefined()
    expect(state.retainedAgentsByPaneKey[targetPaneKey]).toBeUndefined()
    expect(state.retentionSuppressedPaneKeys[sourcePaneKey]).toBeUndefined()
    hook.unmount()
  })

  it('keeps a wrapped-history completion in position through disappearance retention', () => {
    const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
    const store = useAppStore.getState()
    store.setAgentStatus(
      paneKey,
      { state: 'working', prompt: 'task', agentType: 'pi' },
      undefined,
      {
        updatedAt: 1000
      }
    )
    for (let i = 0; i < 23; i++) {
      store.setAgentStatus(
        paneKey,
        { state: i % 2 ? 'working' : 'done', prompt: 'task', agentType: 'pi' },
        undefined,
        { updatedAt: 3000 + i * 1000 }
      )
    }
    const entry = useAppStore.getState().agentStatusByPaneKey[paneKey]
    expect(entry.stateHistory[0].startedAt).toBeGreaterThan(2000)
    const previous = buildRetainedAgentsSyncSnapshot({
      repos: [makeRepo()],
      worktreesByRepo: { 'repo-1': [makeWorktree()] },
      folderWorkspaces: [],
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1' })] },
      agentStatusByPaneKey: { [paneKey]: entry },
      now: 30000
    })
    const result = collectRetainedAgentsOnDisappear({
      previousAgents: previous.currentAgents,
      currentAgents: new Map(),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
    })
    expect(result.toRetain[0]?.startedAt).toBe(1000)
    const quiet = makeAgentRow({
      paneKey: makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222'),
      state: 'working'
    }).entry
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab({ id: 'tab-2' })],
      entries: [{ ...quiet, stateStartedAt: 2000 }],
      retained: result.toRetain,
      now: 30000
    })
    expect(rows.map((row) => row.paneKey)).toEqual([paneKey, quiet.paneKey])
  })
})
