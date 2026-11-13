import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './graph-sync-scheduler'
import type { AppState } from '../../store/types'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-session-contracts'

function leafIdFor(index: number): string {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
}

/** Distinct ids per test: the publication memo is module state shared in this file. */
function makeState(prefix: string, worktreeCount: number, titles: string[] = []): AppState {
  const tabsByWorktree: Record<string, unknown[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  for (let i = 0; i < worktreeCount; i++) {
    const tabId = `${prefix}-term-${i}`
    tabsByWorktree[`repo::/${prefix}-wt-${i}`] = [
      { id: tabId, title: titles[i] ?? `Agent ${i}`, customTitle: null, ptyId: null }
    ]
    terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId: leafIdFor(i) },
      activeLeafId: leafIdFor(i),
      expandedLeafId: null
    }
  }
  return {
    tabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {}
  } as unknown as AppState
}

function graphOf(call: unknown[] | undefined): RuntimeSyncWindowGraph {
  return call?.[0] as RuntimeSyncWindowGraph
}

function publishedWorktrees(call: unknown[] | undefined): string[] {
  return (graphOf(call).mobileSessionTabs ?? []).map((snapshot) => snapshot.worktree).sort()
}

function withheldWorktrees(call: unknown[] | undefined): string[] {
  return [...(graphOf(call).unchangedMobileSessionWorktrees ?? [])].sort()
}

async function flushSync(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function startSync(
  state: AppState,
  syncWindowGraph: ReturnType<typeof vi.fn>
): { setState: (next: AppState) => void } {
  let current = state
  vi.useFakeTimers()
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(() => current)
  setRuntimeGraphSyncEnabled(true)
  return {
    setState: (next: AppState) => {
      current = next
    }
  }
}

describe('mobile session graph payload partition', () => {
  it('republishes a changed worktree whose publication threw before it was acknowledged', async () => {
    const syncWindowGraph = vi.fn().mockResolvedValue({})
    const { setState } = startSync(makeState('c', 3), syncWindowGraph)
    await flushSync()

    // The publication carrying c-wt-1's new snapshot fails in flight.
    setState(makeState('c', 3, ['Agent 0', 'Agent 1 (done)', 'Agent 2']))
    syncWindowGraph.mockRejectedValueOnce(new Error('ipc closed'))
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(publishedWorktrees(syncWindowGraph.mock.calls[1])).toEqual(['repo::/c-wt-1'])

    // Nothing changed since, but main never acknowledged it: resend, don't withhold.
    scheduleRuntimeGraphSync()
    await flushSync()

    expect(syncWindowGraph).toHaveBeenCalledTimes(3)
    expect(publishedWorktrees(syncWindowGraph.mock.calls[2])).toEqual(['repo::/c-wt-1'])
    expect(withheldWorktrees(syncWindowGraph.mock.calls[2])).toEqual([
      'repo::/c-wt-0',
      'repo::/c-wt-2'
    ])
  })

  it('republishes worktrees main reports it dropped after acknowledging them', async () => {
    const syncWindowGraph = vi.fn().mockResolvedValue({})
    startSync(makeState('e', 3), syncWindowGraph)
    await flushSync()

    syncWindowGraph.mockResolvedValueOnce({ mobileSessionResyncWorktrees: ['repo::/e-wt-2'] })
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(withheldWorktrees(syncWindowGraph.mock.calls[1])).toHaveLength(3)

    // The resync reply schedules its own republish; no store change is needed.
    await flushSync()

    expect(syncWindowGraph).toHaveBeenCalledTimes(3)
    expect(publishedWorktrees(syncWindowGraph.mock.calls[2])).toEqual(['repo::/e-wt-2'])
    expect(withheldWorktrees(syncWindowGraph.mock.calls[2])).toEqual([
      'repo::/e-wt-0',
      'repo::/e-wt-1'
    ])
  })
})
