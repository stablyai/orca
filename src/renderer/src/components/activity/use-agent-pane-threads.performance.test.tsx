// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
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

function installPanes(count: number): string[] {
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
      prompt: `Task ${tab.id}`,
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

describe('agent thread list reuse', () => {
  it.each([40, 400])('rebuilds only the pinged thread among %i panes', (count) => {
    const panes = installPanes(count)
    const activity = renderHook(() =>
      useAgentPaneThreads({
        query: '',
        readFilter: 'all',
        groupBy: 'none',
        selectedPaneKey: null,
        showChildAgents: true
      })
    )
    const before = activity.result.current.allThreads
    expect(before).toHaveLength(count)
    const pinged = panes[9]

    act(() => {
      const entries = useAppStore.getState().agentStatusByPaneKey
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...entries,
          [pinged]: { ...entries[pinged], prompt: 'Follow-up prompt' }
        }
      })
    })

    const after = activity.result.current.allThreads
    expect(after.map((thread) => thread.paneKey)).toEqual(before.map((thread) => thread.paneKey))
    // Memoized rows compare thread identity; only the pinged pane's row may see a new object.
    const rebuilt = after.filter((thread, index) => thread !== before[index])
    expect(rebuilt.map((thread) => thread.paneKey)).toEqual([pinged])
    expect(rebuilt[0]?.currentAgentEntry?.prompt).toBe('Follow-up prompt')
  })
})
