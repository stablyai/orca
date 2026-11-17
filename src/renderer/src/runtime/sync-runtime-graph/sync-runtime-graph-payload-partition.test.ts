import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './graph-sync-scheduler'
import type { AppState } from '../../store/types'
import { acceptedAgentStatuses } from '../../store/slices/agent-status/accepted-agent-statuses'
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

describe('saved browser inventory publication scope', () => {
  it.each([10, 100])(
    'coalesces hidden sibling metadata at %i worktrees without unrelated publication',
    async (count) => {
      const state = makeState(`inventory-${count}`, 0)
      state.browserTabsByWorktree = {}
      state.browserPagesByWorkspace = {}
      for (let index = 0; index < count; index++) {
        const worktree = `repo::/inventory-${count}-${index}`
        const workspace = `browser-${count}-${index}`
        const pages = ['hidden', 'selected'].map((suffix) => ({
          id: `${workspace}-${suffix}`,
          workspaceId: workspace,
          worktreeId: worktree,
          title: suffix,
          url: `https://example.com/${suffix}`,
          browserRuntimeEnvironmentId: null,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          faviconUrl: null,
          loadError: null,
          createdAt: 1
        }))
        state.browserPagesByWorkspace[workspace] = pages
        state.browserTabsByWorktree[worktree] = [
          {
            ...pages[1]!,
            id: workspace,
            pageIds: pages.map((page) => page.id),
            activePageId: pages[1]!.id
          }
        ]
      }
      const syncWindowGraph = vi.fn().mockResolvedValue({})
      const { setState } = startSync(state, syncWindowGraph)
      await flushSync()
      const workspace = `browser-${count}-0`
      const pages = state.browserPagesByWorkspace[workspace]!
      const rename = {
        ...state,
        browserPagesByWorkspace: {
          ...state.browserPagesByWorkspace,
          [workspace]: [{ ...pages[0]!, title: 'Updated hidden page' }, pages[1]!]
        }
      }
      setState(rename)
      // A burst has one changed worktree, independently of how many other worktrees are saved.
      for (let index = 0; index < count; index++) {
        scheduleRuntimeGraphSync()
      }
      await flushSync()
      expect(syncWindowGraph).toHaveBeenCalledTimes(2)
      expect(publishedWorktrees(syncWindowGraph.mock.calls[1])).toEqual([
        `repo::/inventory-${count}-0`
      ])
      expect(withheldWorktrees(syncWindowGraph.mock.calls[1])).toHaveLength(count - 1)
      expect(
        graphOf(syncWindowGraph.mock.calls[1]).mobileSessionTabs?.[0]?.browserPageInventory?.[0]
          ?.title
      ).toBe('Updated hidden page')
      // Guest loading/favicon churn changes no saved listing field or visible selected row.
      setState({
        ...rename,
        browserPagesByWorkspace: {
          ...rename.browserPagesByWorkspace,
          [workspace]: [
            {
              ...rename.browserPagesByWorkspace[workspace]![0]!,
              loading: true,
              faviconUrl: 'https://example.com/icon.png'
            },
            pages[1]!
          ]
        }
      })
      scheduleRuntimeGraphSync()
      await flushSync()
      expect(publishedWorktrees(syncWindowGraph.mock.calls[2])).toEqual([])
      expect(withheldWorktrees(syncWindowGraph.mock.calls[2])).toHaveLength(count)
    }
  )
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
