import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/types'

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

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)
  warnTerminalLifecycleAnomaly.mockClear()
  vi.unstubAllGlobals()
})

async function captureGraph(): Promise<RuntimeSyncWindowGraph> {
  const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(() => automationState())
  setRuntimeGraphSyncEnabled(true)
  await flushMicrotasks()
  expect(syncWindowGraph).toHaveBeenCalledTimes(1)
  return syncWindowGraph.mock.calls[0]![0] as RuntimeSyncWindowGraph
}

describe('syncRuntimeGraph background automation tabs', () => {
  it('publishes an unmounted automation tab leaf when its PTY is still live (eager buffer present)', async () => {
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === AUTO_PTY ? { flush: () => '', dispose: () => {} } : undefined
    )

    const graph = await captureGraph()

    expect(graph.leaves).toContainEqual(
      expect.objectContaining({ tabId: 'auto-tab-1', leafId: LEAF, ptyId: AUTO_PTY })
    )
    expect(graph.tabs).toContainEqual(expect.objectContaining({ tabId: 'auto-tab-1' }))
    // Why: the no-live-transport anomaly must stay scoped to mounted tabs; an
    // unmounted background tab legitimately has no live transport yet.
    expect(warnTerminalLifecycleAnomaly).not.toHaveBeenCalled()
  })

  it('does not publish an unmounted tab whose saved PTY is no longer live (no eager buffer)', async () => {
    vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)

    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: 'auto-tab-1' }))
    expect(graph.tabs).not.toContainEqual(expect.objectContaining({ tabId: 'auto-tab-1' }))
  })
})
