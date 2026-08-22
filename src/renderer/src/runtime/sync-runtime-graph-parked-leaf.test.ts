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
  // Why opt-out: a case that needs a non-default layout installs its own getter
  // before calling in, and must not have it overwritten here.
  if (options.seedState !== false) {
    setRuntimeGraphStoreStateGetter(() => parkedState())
  }
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

  // Why these two cases exist: `paneIdByPtyId` and `tabPtyId` both survive the
  // states below, so a predicate reading either one would pass every other test
  // here while publishing a dead terminal.
  it('drops the leaf when per-PTY disposal leaves only the pane-id slot behind', async () => {
    // Exactly what handlePtyExit and disposeParkedTerminalWatchersForPtyIds
    // leave: the disposer is gone, the pane-id slot and tabPtyId remain.
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'wt-1',
      tabPtyId: PARKED_PTY,
      paneIdByPtyId: new Map([[PARKED_PTY, 1]]),
      disposersByPtyId: new Map()
    })

    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('drops the leaf when the PTY exited into the park handoff gap', async () => {
    // The watcher entry looks live, but the exit arrived while no handler owned
    // the PTY, so it was buffered and the watcher's sidecar never saw it.
    installParkedWatcher(PARKED_PTY)
    bufferPreHandlerPtyExit(PARKED_PTY, 0)

    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('does not publish a stale saved PTY that no watcher owns', async () => {
    // The tab is parked, but the layout binding points at a PTY the park wiring
    // never watched — ptyIdsByLeafId is merged and never pruned, so a stale
    // binding must not resurrect a leaf.
    installParkedWatcher('wt-1::/tmp/wt@@some-other-pty')

    const graph = await captureGraph()

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('excludes a remote-runtime PTY, whose parked watcher never sees an exit', async () => {
    // startParkedPtyWatcher installs no exit subscription for remote: PTYs and
    // the parked fact stream carries no exit fact, so a surviving disposer is
    // not evidence the remote terminal is still alive.
    const remotePtyId = 'remote:env-1@@term_remote'
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'wt-1',
      tabPtyId: remotePtyId,
      paneIdByPtyId: new Map([[remotePtyId, 1]]),
      disposersByPtyId: new Map([[remotePtyId, () => {}]])
    })
    setRuntimeGraphStoreStateGetter(() => parkedState({ [LEAF]: remotePtyId }))

    const graph = await captureGraph({ seedState: false })

    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ tabId: TAB_ID }))
  })

  it('publishes the pane id the watcher uses, not a positional ordinal', async () => {
    // PaneManager retires a closed pane's id without renumbering, and main
    // routes split/close and the paneKey fallback through this value. Sourced
    // from the watcher entry, so a leaf the unmount capture never saw — one the
    // layout gained while parked — is still named correctly.
    installParkedWatcher(PARKED_PTY, 7)

    const graph = await captureGraph()

    expect(graph.leaves).toContainEqual(
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF, paneRuntimeId: 7 })
    )
  })

  it("publishes the parked pane's runtime title instead of discarding it", async () => {
    // The parked byte watcher keeps writing this slot and main prefers
    // leaf.paneTitle over its own older lastOscTitle, so publishing null pins a
    // parked agent pane to a stale title for as long as it stays parked.
    installParkedWatcher(PARKED_PTY, 7)
    setRuntimeGraphStoreStateGetter(() => ({
      ...parkedState(),
      runtimePaneTitlesByTabId: { [TAB_ID]: { 7: 'codex [working]' } }
    }))

    const graph = await captureGraph({ seedState: false })

    expect(graph.leaves).toContainEqual(
      expect.objectContaining({ leafId: LEAF, paneTitle: 'codex [working]' })
    )
  })

  it('does not name an active leaf this publication is not sending', async () => {
    // Partial coverage is legitimate: one leaf's watcher can be disposed while a
    // sibling stays parked, and the saved activeLeafId may be the dropped one.
    const otherLeaf = '33333333-3333-4333-8333-333333333333'
    const otherPty = 'wt-1::/tmp/wt@@other-parked-pty'
    installParkedWatcher(PARKED_PTY)
    setRuntimeGraphStoreStateGetter(() =>
      parkedState({ [LEAF]: PARKED_PTY, [otherLeaf]: otherPty }, otherLeaf)
    )

    const graph = await captureGraph({ seedState: false })

    expect(graph.tabs).toContainEqual(
      expect.objectContaining({ tabId: TAB_ID, activeLeafId: LEAF })
    )
    expect(graph.leaves).not.toContainEqual(expect.objectContaining({ leafId: otherLeaf }))
  })
})
