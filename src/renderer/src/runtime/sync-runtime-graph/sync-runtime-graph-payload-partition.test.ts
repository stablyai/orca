import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './graph-sync-scheduler'
import type { AppState } from '../../store/types'
import { acceptedAgentStatuses } from '../../store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type { RuntimeSyncWindowGraph } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the graph publisher reads only these slices of AppState.
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
    agentStatusByPaneKey: acceptedAgentStatuses(),
    browserTabsByWorktree: {}
  } as unknown as AppState
}

function graphOf(call: unknown[] | undefined): RuntimeSyncWindowGraph {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the first syncWindowGraph argument is the published graph.
  return call?.[0] as RuntimeSyncWindowGraph
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

describe('orchestration graph reply', () => {
  it('keeps the applied projection when main answers unchanged, and restores it after a local edit', async () => {
    const context: AgentStatusOrchestrationContext = {
      taskId: 'task-1',
      dispatchId: 'dispatch-1',
      dispatchStatus: 'dispatched'
    }
    const current = makeState('orchestration', 1)
    current.runtimeAgentOrchestrationByPaneKey = {}
    current.setRuntimeAgentOrchestrationByPaneKey = (next) => {
      current.runtimeAgentOrchestrationByPaneKey = next
    }
    const syncWindowGraph = vi
      .fn()
      .mockResolvedValueOnce({
        agentOrchestrationRevision: 4,
        agentOrchestrationByPaneKey: { 'tab:leaf': context }
      })
      .mockResolvedValueOnce({ agentOrchestrationRevision: 4 })
      .mockResolvedValueOnce({
        agentOrchestrationRevision: 4,
        agentOrchestrationByPaneKey: { 'tab:leaf': context }
      })
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    setRuntimeGraphStoreStateGetter(() => current)
    setRuntimeGraphSyncEnabled(true)
    await flushSync()
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(graphOf(syncWindowGraph.mock.calls[1]).agentOrchestrationBase).toBe(4)
    expect(current.runtimeAgentOrchestrationByPaneKey).toEqual({ 'tab:leaf': context })

    current.runtimeAgentOrchestrationByPaneKey = {}
    scheduleRuntimeGraphSync()
    await flushSync()
    expect(graphOf(syncWindowGraph.mock.calls[2]).agentOrchestrationBase).toBeUndefined()
    expect(current.runtimeAgentOrchestrationByPaneKey).toEqual({ 'tab:leaf': context })
  })
})
