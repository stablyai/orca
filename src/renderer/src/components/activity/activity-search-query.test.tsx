// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import {
  LEAF_ID,
  makeRepo,
  makeTabWithIds,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'
import {
  activityThreadMatchesSearchQuery,
  createActivityThreadSearchMatcher
} from './activity-thread-grouping'
import { useAgentPaneThreads } from './use-agent-pane-threads'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installThreads(count: number, prompt = 'Task PROJECT ☃ progress'): string[] {
  vi.spyOn(Date, 'now').mockReturnValue(100_000)
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tabs = Array.from({ length: count }, (_, index) =>
    makeTabWithIds(`tab-${index}`, worktree.id)
  )
  const entries: Record<string, AgentStatusEntry> = {}
  for (const tab of tabs) {
    const paneKey = makePaneKey(tab.id, LEAF_ID)
    entries[paneKey] = {
      paneKey,
      state: 'working',
      prompt,
      agentType: 'claude',
      updatedAt: 100_000,
      stateStartedAt: 99_000,
      stateHistory: []
    }
  }
  useAppStore.setState({
    agentStatusByPaneKey: entries,
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    folderWorkspaces: [],
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [worktree.id]: tabs },
    unifiedTabsByWorktree: {},
    agentsVisibleHostIds: null,
    agentsFilterRepoIds: []
  })
  return Object.keys(entries)
}

function options(query: string): Parameters<typeof useAgentPaneThreads>[0] {
  return { query, readFilter: 'all', groupBy: 'none', selectedPaneKey: null, showChildAgents: true }
}

describe('Activity search query in the real hook', () => {
  it('matches normalized Unicode queries without replacing thread objects', () => {
    const count = 12
    installThreads(count)
    const activity = renderHook(() => useAgentPaneThreads(options(' PROJECT ☃ ')))
    expect(activity.result.current.allThreads).toHaveLength(count)
    expect(activity.result.current.visibleThreads).toEqual(activity.result.current.allThreads)
    for (const [index, thread] of activity.result.current.visibleThreads.entries()) {
      expect(thread).toBe(activity.result.current.allThreads[index])
    }
  })

  it.each(['', ' \t\n '])('shows all threads for an empty query: %j', (query) => {
    installThreads(12)
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    expect(activity.result.current.visibleThreads).toEqual(activity.result.current.allThreads)
  })

  it('retains both original and normalized UTF-8 byte limits', () => {
    const query = 'İ'.repeat(700)
    installThreads(12, query)
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    expect(activity.result.current.allThreads).toHaveLength(12)
    expect(activity.result.current.visibleThreads).toEqual([])
  })

  it('excludes acknowledged rows from an unread search', () => {
    const panes = installThreads(12)
    useAppStore.setState({
      acknowledgedAgentsByPaneKey: Object.fromEntries(panes.map((paneKey) => [paneKey, 100_000]))
    })
    const activity = renderHook(() =>
      useAgentPaneThreads({ ...options(' PROJECT ☃ '), readFilter: 'unread' })
    )
    expect(activity.result.current.allThreads).toHaveLength(12)
    expect(activity.result.current.visibleThreads).toEqual([])
  })

  it('keeps selection, child classification and scoped row order', () => {
    const panes = installThreads(8)
    const parent = panes[0]
    const child = panes[1]
    useAppStore.setState({
      runtimeAgentOrchestrationByPaneKey: {
        [child]: { parentPaneKey: parent, taskId: 'task', dispatchId: 'dispatch' }
      },
      acknowledgedAgentsByPaneKey: { [child]: 100_000 }
    })
    const activity = renderHook((input) => useAgentPaneThreads(input), {
      initialProps: {
        ...options('PROJECT'),
        readFilter: 'unread' as const,
        showChildAgents: false,
        selectedPaneKey: child
      }
    })
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual(panes)
    act(() => useAppStore.setState({ agentsVisibleHostIds: [toSshExecutionHostId('other')] }))
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual([child])
    activity.rerender({
      ...options('NO MATCH'),
      readFilter: 'unread',
      showChildAgents: false,
      selectedPaneKey: child
    })
    expect(activity.result.current.visibleThreads).toEqual([])
    expect(activity.result.current.effectiveSelectedPaneKey).toBe(child)
  })

  it('uses a changed query and new thread data without a retained query cache', () => {
    const panes = installThreads(12, 'first prompt')
    const activity = renderHook((query) => useAgentPaneThreads(options(query)), {
      initialProps: 'first'
    })
    expect(activity.result.current.visibleThreads).toHaveLength(12)
    activity.rerender('second')
    expect(activity.result.current.visibleThreads).toEqual([])
    act(() => {
      const entries = useAppStore.getState().agentStatusByPaneKey
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...entries,
          [panes[2]]: { ...entries[panes[2]], prompt: 'second prompt' }
        }
      })
    })
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual([
      panes[2]
    ])
  })

  it('rejects original oversized whitespace before it becomes an empty query', () => {
    installThreads(12)
    const query = ' '.repeat(2049)
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    expect(activity.result.current.visibleThreads).toEqual([])
  })
})

describe('Activity search matcher APIs', () => {
  it('matches Unicode and byte boundaries against independent expected results', () => {
    installThreads(
      1,
      `Unicode İ 👩🏽‍💻 and BILLING ${'x'.repeat(2049)} ${'é'.repeat(1025)} ${'İ'.repeat(700)}`
    )
    const activity = renderHook(() => useAgentPaneThreads(options('')))
    const thread = activity.result.current.allThreads[0]
    const queries = [
      { query: '', expected: true },
      { query: '\t\n ', expected: true },
      { query: 'BILLING', expected: true },
      { query: '  Unicode İ ', expected: true },
      { query: '👩🏽‍💻', expected: true },
      { query: '\ud800', expected: false },
      { query: 'x'.repeat(2048), expected: true },
      { query: 'x'.repeat(2049), expected: false },
      { query: 'é'.repeat(1024), expected: true },
      { query: 'é'.repeat(1025), expected: false },
      { query: 'İ'.repeat(700), expected: true }
    ]
    for (const { query, expected } of queries) {
      expect(createActivityThreadSearchMatcher(query)(thread), query).toBe(expected)
      expect(activityThreadMatchesSearchQuery({ thread, searchQuery: query }), query).toBe(expected)
    }
  })
})
