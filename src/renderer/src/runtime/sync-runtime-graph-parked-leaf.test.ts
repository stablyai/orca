/**
 * Cold-parked tabs keep their runtime-graph leaf while their PTY is alive.
 *
 * Why this matters beyond the host UI (STA-2854): the graph leaf is what mints
 * the terminal handle a paired client's stream is bound to. Publishing only
 * mounted panes meant a host that merely stopped *displaying* a terminal
 * invalidated that handle, stalling a remote viewer who was actively driving it.
 *
 * The liveness proof is the parked watcher, which the park wiring starts on
 * unmount and disposes on reveal, tab close, PTY exit, and worktree teardown —
 * so a dead terminal still drops out of the graph.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

vi.mock('@/components/terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-dispatcher'
import { parkedWatchersByTabId } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './sync-runtime-graph'

const LEAF = '22222222-2222-4222-8222-222222222222'
const PARKED_PTY = 'wt-1::/tmp/wt@@parked-pty'
const TAB_ID = 'parked-tab-1'

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

function parkedState(): AppState {
  return makeState({
    tabsByWorktree: { 'wt-1': [parkedTab()] } as AppState['tabsByWorktree'],
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PARKED_PTY }
      }
    } as AppState['terminalLayoutsByTabId']
  })
}

/** Installs the exact registry state the park wiring leaves behind on unmount. */
function installParkedWatcher(ptyId: string): void {
  parkedWatchersByTabId.set(TAB_ID, {
    worktreeId: 'wt-1',
    tabPtyId: ptyId,
    paneIdByPtyId: new Map([[ptyId, 1]]),
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
  vi.mocked(getEagerPtyBufferHandle).mockReturnValue(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function captureGraph(): Promise<RuntimeSyncWindowGraph> {
  vi.useFakeTimers()
  const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(() => parkedState())
  setRuntimeGraphSyncEnabled(true)
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
  expect(syncWindowGraph).toHaveBeenCalledTimes(1)
  return syncWindowGraph.mock.calls[0]?.[0] as RuntimeSyncWindowGraph
}

describe('syncRuntimeGraph cold-parked tabs', () => {
  it('publishes a parked tab leaf while a parked watcher still owns its PTY', async () => {
    installParkedWatcher(PARKED_PTY)

    const graph = await captureGraph()

    expect(graph.leaves).toContainEqual(
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF, ptyId: PARKED_PTY })
    )
    expect(graph.tabs).toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('drops the leaf once the watcher is disposed (reveal, close, PTY exit, teardown)', async () => {
    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
    expect(graph.tabs).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('does not publish a stale saved PTY that no watcher owns', async () => {
    // The tab is parked, but the layout binding points at a PTY the park wiring
    // never watched — ptyIdsByLeafId is merged and never pruned, so a stale
    // binding must not resurrect a leaf.
    installParkedWatcher('wt-1::/tmp/wt@@some-other-pty')

    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })
})
