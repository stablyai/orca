// Live parked leaves preserve paired-client terminal handles (STA-2854); unmount alone must not invalidate actively viewed streams. Park watchers prove liveness and retire on reveal/close/exit/workspace teardown so dead terminals still disappear.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AppState } from '../store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

vi.mock('@/components/terminal-pane/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

import { getEagerPtyBufferHandle } from '@/components/terminal-pane/pty-dispatcher'
import {
  bufferPreHandlerPtyExit,
  clearPreHandlerPtyState
} from '@/components/terminal-pane/pty-pre-handler-buffer'
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

function reportedTabIds(graph: RuntimeSyncWindowGraph): string[] {
  return ORCA_LAYOUT_OWNER_IS_MAIN
    ? (graph.mountedLeaves ?? []).map((leaf) => leaf.tabId)
    : graph.tabs.map((tab) => tab.tabId)
}

/** The window's PTY claim, which only a window-owned build reports. */
function withPty(ptyId: string): { ptyId?: string } {
  return ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { ptyId }
}

describe('syncRuntimeGraph cold-parked tabs', () => {
  it('publishes a parked tab leaf while a parked watcher still owns its PTY', async () => {
    installParkedWatcher(PARKED_PTY)

    const graph = await captureGraph()

    expect(reportedPanes(graph)).toContainEqual(
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF, ...withPty(PARKED_PTY), parked: true })
    )
    expect(reportedTabIds(graph)).toContain(TAB_ID)
  })

  // Stale paneIdByPtyId/tabPtyId survive these cases; tests must reject those false liveness proofs.
  it('drops the leaf when per-PTY disposal leaves only the pane-id slot behind', async () => {
    // PTY exit removes disposer but retains pane-ID slot and tabPtyId.
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'wt-1',
      tabPtyId: PARKED_PTY,
      paneIdByPtyId: new Map([[PARKED_PTY, 1]]),
      disposersByPtyId: new Map()
    })

    const graph = await captureGraph()

    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('drops the leaf when the PTY exited into the park handoff gap', async () => {
    // Exit buffered without a PTY owner leaves an apparently live watcher whose sidecar missed it.
    installParkedWatcher(PARKED_PTY)
    bufferPreHandlerPtyExit(PARKED_PTY, 0)

    const graph = await captureGraph()

    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('does not publish a stale saved PTY that no watcher owns', async () => {
    // Persisted ptyIdsByLeafId is never pruned; stale bindings must not resurrect unwatched parked leaves.
    installParkedWatcher('wt-1::/tmp/wt@@some-other-pty')

    const graph = await captureGraph()

    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('excludes a remote-runtime PTY, whose parked watcher never sees an exit', async () => {
    // Remote watchers lack exit subscriptions/facts; surviving disposers cannot prove remote liveness.
    const remotePtyId = 'remote:env-1@@term_remote'
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'wt-1',
      tabPtyId: remotePtyId,
      paneIdByPtyId: new Map([[remotePtyId, 1]]),
      disposersByPtyId: new Map([[remotePtyId, () => {}]])
    })
    setRuntimeGraphStoreStateGetter(() => parkedState({ [LEAF]: remotePtyId }))

    const graph = await captureGraph({ seedState: false })

    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('publishes the pane id the watcher uses, not a positional ordinal', async () => {
    // Closed pane IDs never renumber; watcher capture preserves split/close/paneKey routing even for leaves added while parked.
    installParkedWatcher(PARKED_PTY, 7)

    const graph = await captureGraph()

    expect(reportedPanes(graph)).toContainEqual(
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF, paneRuntimeId: 7 })
    )
  })

  it("publishes the parked pane's runtime title instead of discarding it", async () => {
    // Publish watcher-updated pane title; null leaves main preferring stale lastOscTitle forever.
    installParkedWatcher(PARKED_PTY, 7)
    setRuntimeGraphStoreStateGetter(() => ({
      ...parkedState(),
      runtimePaneTitlesByTabId: { [TAB_ID]: { 7: 'codex [working]' } }
    }))

    const graph = await captureGraph({ seedState: false })

    expect(reportedPanes(graph)).toContainEqual(
      expect.objectContaining({ leafId: LEAF, paneTitle: 'codex [working]' })
    )
  })

  it('does not name an active leaf this publication is not sending', async () => {
    // Partial watcher coverage can drop the saved active leaf while keeping siblings.
    const otherLeaf = '33333333-3333-4333-8333-333333333333'
    const otherPty = 'wt-1::/tmp/wt@@other-parked-pty'
    installParkedWatcher(PARKED_PTY)
    setRuntimeGraphStoreStateGetter(() =>
      parkedState({ [LEAF]: PARKED_PTY, [otherLeaf]: otherPty }, otherLeaf)
    )

    const graph = await captureGraph({ seedState: false })

    // With the switch on, the active pane is main's own selection (runtime-leaf-record-projection.test.ts).
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      expect(graph.tabs).toContainEqual(
        expect.objectContaining({ tabId: TAB_ID, activeLeafId: LEAF })
      )
    }
    expect(reportedPanes(graph)).not.toContainEqual(expect.objectContaining({ leafId: otherLeaf }))
  })
})
