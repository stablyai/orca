// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useAppStore } from '@/store/index'
import { resetAgentPaneAuthorityAliasesForTests } from '@/store/slices/agent-status/agent-pane-authority'
import type {
  AgentStatusEntry,
  AgentStatusState
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

import type { Repo } from '../../../../../shared/repo-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { useRetainedAgentsSync } from './useRetainedAgents'

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

describe('useRetainedAgentsSync', () => {
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
    expect(state.retainedAgentsByPaneKey[sourcePaneKey]).toBeUndefined()
    expect(state.retainedAgentsByPaneKey[targetPaneKey]).toBeUndefined()
    hook.unmount()
  })
})
