// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import * as clipboard from '../../../../shared/clipboard-text'
import { useAppStore } from '@/store'
import {
  LEAF_ID,
  makeRepo,
  makeTabWithIds,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'
import {
  activityThreadMatchesSearchQuery,
  createActivityThreadSearchMatcher,
  getThreadSearchTextComputeCount
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

function queryWork(query: string) {
  const texts = new Set([query, query.trim(), query.trim().toLowerCase()].filter(Boolean))
  const originalBudget = clipboard.isClipboardTextByteLengthOverLimit
  const originalTrim = String.prototype.trim
  const originalLower = String.prototype.toLowerCase
  const counts = { budget: 0, trim: 0, lower: 0 }
  const budget = vi
    .spyOn(clipboard, 'isClipboardTextByteLengthOverLimit')
    .mockImplementation((text, maxBytes) => {
      if (texts.has(text)) {
        counts.budget += 1
      }
      return originalBudget(text, maxBytes)
    })
  const trim = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
    if (texts.has(String(this))) {
      counts.trim += 1
    }
    return originalTrim.call(this)
  })
  const lower = vi.spyOn(String.prototype, 'toLowerCase').mockImplementation(function (
    this: string
  ) {
    if (texts.has(String(this))) {
      counts.lower += 1
    }
    return originalLower.call(this)
  })
  return {
    counts,
    restore() {
      budget.mockRestore()
      trim.mockRestore()
      lower.mockRestore()
    }
  }
}

function options(query: string): Parameters<typeof useAgentPaneThreads>[0] {
  return { query, readFilter: 'all', groupBy: 'none', selectedPaneKey: null, showChildAgents: true }
}

describe('Activity search query work in the real hook', () => {
  it.each([12, 128, 1000])('prepares one query for %i live threads', (count) => {
    installThreads(count)
    const work = queryWork(' PROJECT ☃ ')
    const activity = renderHook(() => useAgentPaneThreads(options(' PROJECT ☃ ')))
    work.restore()
    expect(activity.result.current.allThreads).toHaveLength(count)
    expect(activity.result.current.visibleThreads).toEqual(activity.result.current.allThreads)
    for (const [index, thread] of activity.result.current.visibleThreads.entries()) {
      expect(thread).toBe(activity.result.current.allThreads[index])
    }
    expect(work.counts).toEqual({ budget: 2, trim: 2, lower: 2 })
  })

  it.each(['', ' \t\n '])('keeps an empty query lazy: %j', (query) => {
    installThreads(12)
    const before = getThreadSearchTextComputeCount()
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    expect(activity.result.current.visibleThreads).toEqual(activity.result.current.allThreads)
    expect(getThreadSearchTextComputeCount()).toBe(before)
  })

  it('retains both original and normalized UTF-8 byte limits', () => {
    const query = 'İ'.repeat(700)
    installThreads(12, query)
    const before = getThreadSearchTextComputeCount()
    const work = queryWork(query)
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    work.restore()
    expect(activity.result.current.allThreads).toHaveLength(12)
    expect(activity.result.current.visibleThreads).toEqual([])
    expect(getThreadSearchTextComputeCount()).toBe(before)
    expect(work.counts.budget).toBe(2)
  })

  it('does not prepare a row query before read/child/scope filters admit a row', () => {
    const panes = installThreads(12)
    useAppStore.setState({
      acknowledgedAgentsByPaneKey: Object.fromEntries(panes.map((paneKey) => [paneKey, 100_000]))
    })
    const work = queryWork(' PROJECT ☃ ')
    const activity = renderHook(() =>
      useAgentPaneThreads({ ...options(' PROJECT ☃ '), readFilter: 'unread' })
    )
    work.restore()
    expect(activity.result.current.allThreads).toHaveLength(12)
    expect(activity.result.current.visibleThreads).toEqual([])
    expect(work.counts).toEqual({ budget: 1, trim: 1, lower: 1 })
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

  it('keeps original oversized query rejection ahead of normalization/search', () => {
    installThreads(12)
    const query = ' '.repeat(2049)
    const before = getThreadSearchTextComputeCount()
    const work = queryWork(query)
    const activity = renderHook(() => useAgentPaneThreads(options(query)))
    work.restore()
    expect(activity.result.current.visibleThreads).toEqual([])
    expect(getThreadSearchTextComputeCount()).toBe(before)
    expect(work.counts).toEqual({ budget: 1, trim: 0, lower: 0 })
  })
})

describe('prepared Activity search preserves the public one-thread matcher', () => {
  it('matches original output and lazy text for Unicode, boundary and empty queries', () => {
    installThreads(8, 'Unicode İ 👩🏽‍💻 and BILLING')
    const activity = renderHook(() => useAgentPaneThreads(options('')))
    const queries = [
      '',
      '\t\n ',
      'BILLING',
      '  Unicode İ ',
      '👩🏽‍💻',
      '\ud800',
      'x'.repeat(2048),
      'é'.repeat(1024),
      'é'.repeat(1025),
      'İ'.repeat(700)
    ]
    for (const searchQuery of queries) {
      const matches = createActivityThreadSearchMatcher(searchQuery)
      expect(activity.result.current.allThreads.map(matches)).toEqual(
        activity.result.current.allThreads.map((thread) =>
          activityThreadMatchesSearchQuery({ thread, searchQuery })
        )
      )
    }
  })
})
