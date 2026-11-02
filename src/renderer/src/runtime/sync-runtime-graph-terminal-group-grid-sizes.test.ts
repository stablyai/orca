import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  scheduleRuntimeGraphSyncIfGroupGridSizesChanged,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'

type GridSizes =
  | {
      groups: Record<string, { cols: number; rows: number }>
      singleGroupWorkspace?: { cols: number; rows: number }
    }
  | undefined
const measured = vi.hoisted((): { sizes: GridSizes } => ({ sizes: undefined }))
vi.mock('./sync-runtime-graph/terminal-group-grid-sizes', () => ({
  measureTerminalGroupGridSizes: () => measured.sizes
}))

const EMPTY_STATE = {
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
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
  agentStatusByPaneKey: {},
  browserTabsByWorktree: {}
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

describe('terminal group grid sizes in the window graph', () => {
  it('republishes only when a refit changed a group grid', async () => {
    const syncWindowGraph = vi
      .fn<(graph: RuntimeSyncWindowGraph) => Promise<object>>()
      .mockResolvedValue({})
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph sync reads only these collections of the store.
    setRuntimeGraphStoreStateGetter(() => EMPTY_STATE as unknown as AppState)
    measured.sizes = {
      groups: { 'group-a': { cols: 63, rows: 60 } },
      singleGroupWorkspace: { cols: 130, rows: 60 }
    }
    setRuntimeGraphSyncEnabled(true)
    await flushSync()
    expect(syncWindowGraph.mock.calls[0]?.[0]).toMatchObject({
      terminalGroupGridSizes: { 'group-a': { cols: 63, rows: 60 } },
      singleGroupWorkspaceGridSize: { cols: 130, rows: 60 }
    })

    scheduleRuntimeGraphSyncIfGroupGridSizesChanged()
    await flushSync()
    expect(syncWindowGraph).toHaveBeenCalledTimes(1)

    measured.sizes = {
      groups: { 'group-a': { cols: 66, rows: 60 } },
      singleGroupWorkspace: { cols: 130, rows: 60 }
    }
    scheduleRuntimeGraphSyncIfGroupGridSizesChanged()
    await flushSync()
    expect(syncWindowGraph).toHaveBeenCalledTimes(2)
    expect(syncWindowGraph.mock.calls[1]?.[0].terminalGroupGridSizes).toEqual({
      'group-a': { cols: 66, rows: 60 }
    })
  })

  it('leaves the field out until a pane can be measured', async () => {
    const syncWindowGraph = vi
      .fn<(graph: RuntimeSyncWindowGraph) => Promise<object>>()
      .mockResolvedValue({})
    vi.useFakeTimers()
    vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
    vi.stubGlobal('HTMLElement', class HTMLElement {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph sync reads only these collections of the store.
    setRuntimeGraphStoreStateGetter(() => EMPTY_STATE as unknown as AppState)
    measured.sizes = undefined
    setRuntimeGraphSyncEnabled(true)
    await flushSync()
    expect(syncWindowGraph.mock.calls[0]?.[0]).not.toHaveProperty('terminalGroupGridSizes')
  })
})
