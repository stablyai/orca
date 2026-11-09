// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import {
  LEAF_ID,
  makeRepo,
  makeTabWithIds,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'

import { useAgentPaneThreads } from './use-agent-pane-threads'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
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
  it('keeps live rows but excludes acknowledged finished rows from an unread search', () => {
    const panes = installThreads(12)
    const entries = useAppStore.getState().agentStatusByPaneKey
    useAppStore.setState({
      agentStatusByPaneKey: Object.fromEntries(
        panes.map((paneKey, index) => [
          paneKey,
          index === 0 ? entries[paneKey] : { ...entries[paneKey], state: 'done' as const }
        ])
      ),
      acknowledgedAgentsByPaneKey: Object.fromEntries(panes.map((paneKey) => [paneKey, 100_000]))
    })
    const activity = renderHook(() =>
      useAgentPaneThreads({ ...options(' PROJECT ☃ '), readFilter: 'unread' })
    )
    expect(activity.result.current.allThreads).toHaveLength(12)
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual([
      panes[0]
    ])
  })

  it('hides acknowledged unavailable rows unless selected in the unread filter', () => {
    const [livePane, unavailablePane] = installThreads(2)
    const entries = useAppStore.getState().agentStatusByPaneKey
    useAppStore.setState({
      agentStatusByPaneKey: { [livePane]: entries[livePane] },
      migrationUnsupportedByPtyId: {
        'pty-tab-1': {
          ptyId: 'pty-tab-1',
          paneKey: unavailablePane,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 99_000
        }
      },
      acknowledgedAgentsByPaneKey: { [livePane]: 100_000, [unavailablePane]: 100_000 }
    })
    const activity = renderHook<ReturnType<typeof useAgentPaneThreads>, string | null>(
      (selectedPaneKey: string | null) =>
        useAgentPaneThreads({ ...options(''), readFilter: 'unread', selectedPaneKey }),
      { initialProps: null }
    )
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual([
      'tab-0:11111111-1111-4111-8111-111111111111'
    ])
    activity.rerender(unavailablePane)
    expect(
      activity.result.current.visibleThreads.map((thread) => thread.paneKey).toSorted()
    ).toEqual([
      'tab-0:11111111-1111-4111-8111-111111111111',
      'tab-1:11111111-1111-4111-8111-111111111111'
    ])
    act(() => useAppStore.setState({ activityClearedAtByPaneKey: { [unavailablePane]: 99_000 } }))
    activity.rerender(null)
    expect(activity.result.current.visibleThreads.map((thread) => thread.paneKey)).toEqual([
      'tab-0:11111111-1111-4111-8111-111111111111'
    ])
    act(() =>
      useAppStore.setState({
        activityClearedAtByPaneKey: {},
        acknowledgedAgentsByPaneKey: { [livePane]: 100_000 }
      })
    )
    expect(
      activity.result.current.visibleThreads.map((thread) => thread.paneKey).toSorted()
    ).toEqual([
      'tab-0:11111111-1111-4111-8111-111111111111',
      'tab-1:11111111-1111-4111-8111-111111111111'
    ])
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
})
