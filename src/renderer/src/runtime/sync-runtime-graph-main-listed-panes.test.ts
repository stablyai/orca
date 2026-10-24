// Layout-owner builds: main lists the panes of a workspace this app owns, so the window's graph
// says only which of them it shows or parks.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import type { AppState } from '../store/types'
import { parkedWatchersByTabId } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import { setRuntimeGraphStoreStateGetter, setRuntimeGraphSyncEnabled } from './sync-runtime-graph'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LEAF = '22222222-2222-4222-8222-222222222222'
const PARKED_PTY = 'wt-1::/tmp/wt@@parked-pty'
const TAB_ID = 'parked-tab-1'

function parkedState(paneTitles: AppState['runtimePaneTitlesByTabId'] = {}): AppState {
  const partial: Partial<AppState> = {
    tabsByWorktree: {
      'wt-1': [
        {
          id: TAB_ID,
          ptyId: PARKED_PTY,
          worktreeId: 'wt-1',
          title: 'agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PARKED_PTY }
      }
    },
    runtimePaneTitlesByTabId: paneTitles,
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the graph sync reads only the slices set above.
  return partial as AppState
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  parkedWatchersByTabId.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function publish(state: () => AppState): Promise<RuntimeSyncWindowGraph | undefined> {
  vi.useFakeTimers()
  const syncWindowGraph = vi.fn(async (_graph: RuntimeSyncWindowGraph) => undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(state)
  setRuntimeGraphSyncEnabled(true)
  await vi.advanceTimersByTimeAsync(20)
  return syncWindowGraph.mock.calls[0]?.[0]
}

function parkWatcher(paneId: number, disposers = true): void {
  parkedWatchersByTabId.set(TAB_ID, {
    worktreeId: 'wt-1',
    tabPtyId: PARKED_PTY,
    paneIdByPtyId: new Map([[PARKED_PTY, paneId]]),
    disposersByPtyId: disposers ? new Map([[PARKED_PTY, () => {}]]) : new Map()
  })
}

describe('syncRuntimeGraph in a layout-owner build', () => {
  it("sends a parked pane of this app's workspace as a mount fact, not a terminal listing", async () => {
    parkWatcher(7)

    const graph = await publish(() => parkedState())

    expect(graph?.tabs).toEqual([])
    expect(graph?.leaves).toEqual([])
    expect(graph?.mountedLeaves).toEqual([
      { tabId: TAB_ID, leafId: LEAF, paneRuntimeId: 7, parked: true, paneTitle: null }
    ])
  })

  it("carries the parked pane's runtime title", async () => {
    parkWatcher(7)

    const graph = await publish(() => parkedState({ [TAB_ID]: { 7: 'codex [working]' } }))

    expect(graph?.mountedLeaves).toEqual([
      expect.objectContaining({ leafId: LEAF, paneTitle: 'codex [working]' })
    ])
  })

  it('sends nothing for a parked pane whose watcher was disposed', async () => {
    parkWatcher(7, false)

    const graph = await publish(() => parkedState())

    expect(graph?.mountedLeaves).toBeUndefined()
  })
})
