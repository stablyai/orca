import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

// Why: Part B publishes never-mounted background automation tabs into the
// runtime graph, gated on a live eager buffer. Stub the eager-buffer lookup so
// the test can flip "still-live unmounted PTY" on and off without the real IPC
// dispatcher, and spy on the anomaly warning to prove it stays scoped to mounted
// tabs.
const { warnTerminalLifecycleAnomaly } = vi.hoisted(() => ({
  warnTerminalLifecycleAnomaly: vi.fn()
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})
vi.mock('@/components/terminal-pane/terminal-lifecycle-diagnostics', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, warnTerminalLifecycleAnomaly }
})

import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-dispatcher'
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './sync-runtime-graph'

const LEAF = '11111111-1111-4111-8111-111111111111'
const AUTO_PTY = 'auto-bg-pty'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
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

function makeAutomationTab(): TerminalTab {
  return {
    id: 'auto-tab-1',
    ptyId: AUTO_PTY,
    worktreeId: 'wt-1',
    title: 'Generate PO review prep brief',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function automationState(): AppState {
  return makeState({
    tabsByWorktree: { 'wt-1': [makeAutomationTab()] } as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {
      'auto-tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: AUTO_PTY }
      }
    } as AppState['terminalLayoutsByTabId']
  })
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushRuntimeGraphSyncTimer(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)
  warnTerminalLifecycleAnomaly.mockClear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function captureGraph(): Promise<RuntimeSyncWindowGraph> {
  vi.useFakeTimers()
  const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(() => automationState())
  setRuntimeGraphSyncEnabled(true)
  await flushRuntimeGraphSyncTimer()
  expect(syncWindowGraph).toHaveBeenCalledTimes(1)
  const graph = syncWindowGraph.mock.calls[0]?.[0]
  expect(graph).toBeDefined()
  return graph as RuntimeSyncWindowGraph
}

/**
 * What this publication reports of the window's terminal panes. A window-owned build lists them;
 * with the switch on, main lists this app's panes and the window reports only what it shows or
 * parks (mountedLeaves), so the PTY id is main's binding and is not reported here.
 */
function reportedPanes(graph: RuntimeSyncWindowGraph): Record<string, unknown>[] {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? (graph.mountedLeaves ?? []) : graph.leaves
}

function reportedTabIds(graph: RuntimeSyncWindowGraph): string[] {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? (graph.mountedLeaves ?? []).map((leaf) => leaf.tabId)
    : graph.tabs.map((tab) => tab.tabId)
}

/** The window's PTY claim, which only a window-owned build reports. */
function withPty(ptyId: string): { ptyId?: string } {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { ptyId }
}

describe('syncRuntimeGraph background automation tabs', () => {
  it('publishes an unmounted automation tab leaf when its PTY is still live (eager buffer present)', async () => {
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === AUTO_PTY ? { flush: () => '', dispose: () => {} } : undefined
    )

    const graph = await captureGraph()

    expect(reportedPanes(graph)).toContainEqual(
      expect.objectContaining({ tabId: 'auto-tab-1', leafId: LEAF, ...withPty(AUTO_PTY) })
    )
    expect(reportedTabIds(graph)).toContain('auto-tab-1')
    // Why: the no-live-transport anomaly must stay scoped to mounted tabs; an
    // unmounted background tab legitimately has no live transport yet.
    expect(warnTerminalLifecycleAnomaly).not.toHaveBeenCalled()
  })

  it('does not publish an unmounted tab whose saved PTY is no longer live (no eager buffer)', async () => {
    vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)

    const graph = await captureGraph()

    expect(reportedPanes(graph)).not.toContainEqual(
      expect.objectContaining({ tabId: 'auto-tab-1' })
    )
    expect(reportedTabIds(graph)).not.toContain('auto-tab-1')
  })
})
