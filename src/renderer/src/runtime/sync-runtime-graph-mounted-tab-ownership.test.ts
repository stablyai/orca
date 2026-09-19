import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'
import {
  registerRuntimeTerminalTab,
  setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled
} from './sync-runtime-graph'
import {
  getTerminalTabOwnershipIndex,
  resetRuntimeGraphSliceScanCaches
} from './sync-runtime-graph/graph-state'
import { makeState } from './sync-runtime-graph-test-harness'

/**
 * The publication loop resolves a mounted surface's tab through the memoized ownership index
 * instead of a per-worktree lookup map rebuilt on every publication. These pin the two rules that
 * map encoded: a registration only sees its own worktree's tab, and a duplicated id addresses none.
 */

const LEAF = '11111111-1111-4111-8111-111111111111'
const OWNER_WT = 'ownership-owner-wt'
const OTHER_WT = 'ownership-other-wt'

function makeTab(id: string, worktreeId: string): TerminalTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path reads only the fields assigned here.
  return { id, worktreeId, title: 'Agent', ptyId: null } as unknown as TerminalTab
}

function registerSurface(tabId: string, worktreeId: string): () => void {
  const pane = { id: 1, leafId: LEAF }
  const manager = {
    getPanes: () => [pane],
    getActivePane: () => pane,
    getLeafId: (paneId: number) => (paneId === pane.id ? pane.leafId : null),
    getNumericIdForLeaf: (leafId: string) => (leafId === pane.leafId ? pane.id : null)
  }
  return registerRuntimeTerminalTab({
    tabId,
    worktreeId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path calls only the PaneManager members stubbed above.
    getManager: () => manager as never,
    getContainer: () => null,
    getPtyIdForPane: (paneId) => (paneId === pane.id ? 'pty-ownership' : null),
    getTabWideAgentHintLeafId: () => null
  })
}

async function captureGraph(state: AppState): Promise<RuntimeSyncWindowGraph> {
  vi.useFakeTimers()
  const syncWindowGraph = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { runtime: { syncWindowGraph } } })
  vi.stubGlobal('HTMLElement', class HTMLElement {})
  setRuntimeGraphStoreStateGetter(() => state)
  setRuntimeGraphSyncEnabled(true)
  await vi.advanceTimersByTimeAsync(20)
  await Promise.resolve()
  await Promise.resolve()
  const graph = syncWindowGraph.mock.calls[0]?.[0]
  expect(graph).toBeDefined()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub records exactly the graph the publication passed.
  return graph as RuntimeSyncWindowGraph
}

afterEach(() => {
  setRuntimeGraphSyncEnabled(false)
  setRuntimeGraphStoreStateGetter(null)
  resetRuntimeGraphSliceScanCaches()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mounted terminal tab resolution', () => {
  it('publishes nothing for a surface registered under a worktree that does not own the tab', async () => {
    const unregister = registerSurface('ownership-tab', OTHER_WT)
    try {
      const graph = await captureGraph(
        makeState({
          tabsByWorktree: {
            [OWNER_WT]: [makeTab('ownership-tab', OWNER_WT)],
            [OTHER_WT]: []
          }
        })
      )

      expect(graph.tabs).toEqual([])
      expect(graph.leaves).toEqual([])
    } finally {
      unregister()
    }
  })

  it('publishes the tab when the registration matches its owning worktree', async () => {
    const unregister = registerSurface('ownership-tab', OWNER_WT)
    try {
      const graph = await captureGraph(
        makeState({ tabsByWorktree: { [OWNER_WT]: [makeTab('ownership-tab', OWNER_WT)] } })
      )

      expect(graph.tabs).toEqual([
        expect.objectContaining({ tabId: 'ownership-tab', worktreeId: OWNER_WT })
      ])
    } finally {
      unregister()
    }
  })
})

describe('terminal tab ownership index', () => {
  it('addresses a tab duplicated within one worktree from neither map', () => {
    const index = getTerminalTabOwnershipIndex({
      [OWNER_WT]: [makeTab('twin', OWNER_WT), makeTab('twin', OWNER_WT), makeTab('solo', OWNER_WT)]
    })

    expect(index.tabById.get('twin')).toBeUndefined()
    expect(index.worktreeIdByTabId.get('twin')).toBeUndefined()
    expect(index.ambiguousTabIds.has('twin')).toBe(true)
    expect(index.tabById.get('solo')).toEqual(expect.objectContaining({ id: 'solo' }))
  })

  it('addresses a tab duplicated across worktrees from neither map', () => {
    const index = getTerminalTabOwnershipIndex({
      [OWNER_WT]: [makeTab('twin', OWNER_WT)],
      [OTHER_WT]: [makeTab('twin', OTHER_WT)]
    })

    expect(index.tabById.get('twin')).toBeUndefined()
    expect(index.worktreeIdByTabId.get('twin')).toBeUndefined()
  })
})
