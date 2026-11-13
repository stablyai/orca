// Live parked leaves preserve paired-client terminal handles (STA-2854); unmount alone must not invalidate actively viewed streams. Park watchers prove liveness and retire on reveal/close/exit/workspace teardown so dead terminals still disappear.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../../shared/runtime-session-contracts'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { AppState } from '../../store/types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'

vi.mock(
  '@/components/terminal-pane/pty-transport/delivery/pty-dispatcher',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
  }
)

import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-transport/delivery/pty-dispatcher'
import {
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState
} from '@/components/terminal-pane/pty-transport/delivery/pty-pre-handler-buffer'
import { parkedWatchersByTabId } from '@/components/terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './graph-sync-scheduler'

const LEAF = '22222222-2222-4222-8222-222222222222'
const PARKED_PTY = 'wt-1::/tmp/wt@@parked-pty'
const TAB_ID = 'parked-tab-1'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    agentStatusByPaneKey: acceptedAgentStatuses(),
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
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
    ...overrides
  } as AppState
}

function parkedTab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: PARKED_PTY,
    worktreeId: 'wt-1',
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as TerminalTab
}

function parkedState(
  ptyIdsByLeafId: Record<string, string> = { [LEAF]: PARKED_PTY },
  activeLeafId: string = LEAF
): AppState {
  const leafIds = Object.keys(ptyIdsByLeafId)
  const root = leafIds.slice(1).reduce<Record<string, unknown>>(
    (first, leafId) => ({
      type: 'split',
      direction: 'horizontal',
      first,
      second: { type: 'leaf', leafId }
    }),
    { type: 'leaf', leafId: leafIds[0] }
  )
  return makeState({
    tabsByWorktree: { 'wt-1': [parkedTab()] } as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root,
        activeLeafId,
        expandedLeafId: null,
        ptyIdsByLeafId
      }
    } as unknown as AppState['terminalLayoutsByTabId']
  })
}

/** Installs the exact registry state the park wiring leaves behind on unmount. */
function installParkedWatcher(ptyId: string, paneId = 1): void {
  parkedWatchersByTabId.set(TAB_ID, {
    worktreeId: 'wt-1',
    tabPtyId: ptyId,
    paneIdByPtyId: new Map([[ptyId, paneId]]),
    disposersByPtyId: new Map([[ptyId, () => {}]])
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  parkedWatchersByTabId.clear()
  clearPreHandlerPtyState(PARKED_PTY)
  vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function captureGraph(
  options: { seedState?: boolean } = {}
): Promise<RuntimeSyncWindowGraph> {
  vi.useFakeTimers()
  const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  // Nondefault-layout callers install their getter first; preserve it.
  if (options.seedState !== false) {
    setRuntimeGraphStoreStateGetter(() => parkedState())
  }
  setRuntimeGraphSyncEnabled(true)
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
  expect(syncWindowGraph).toHaveBeenCalledTimes(1)
  return syncWindowGraph.mock.calls[0]?.[0] as RuntimeSyncWindowGraph
}

/**
 * What this publication reports of the window's terminal panes. A window-owned build lists them;
 * with the switch on, main lists this app's panes and the window reports only what it shows or
 * parks (mountedLeaves), so the PTY id is main's binding and is not reported here.
 */
function reportedPanes(graph: RuntimeSyncWindowGraph): Record<string, unknown>[] {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (graph.mountedLeaves ?? []) : graph.leaves
}

describe('syncRuntimeGraph cold-parked tabs', () => {
  it('drops the leaf when the PTY exited into the park handoff gap', async () => {
    // Exit buffered without a PTY owner leaves an apparently live watcher whose sidecar missed it.
    installParkedWatcher(PARKED_PTY)
    bufferPreHandlerPtyExit(PARKED_PTY, 0)

    const graph = await captureGraph()

    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })
})
