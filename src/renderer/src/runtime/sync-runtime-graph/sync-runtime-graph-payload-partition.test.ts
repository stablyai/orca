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

function makeState(): AppState {
  const tabId = 'orchestration-term-0'
  const leafId = '00000000-1111-4111-8111-111111111111'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the graph publisher reads only these slices of AppState.
  return {
    tabsByWorktree: {
      'repo::/orchestration-wt-0': [{ id: tabId, title: 'Agent 0', customTitle: null, ptyId: null }]
    },
    terminalLayoutsByTabId: {
      [tabId]: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
    },
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
    const current = makeState()
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
