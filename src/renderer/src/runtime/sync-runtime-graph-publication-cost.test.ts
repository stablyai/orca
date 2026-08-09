import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots, registerRuntimeTerminalTab } from './sync-runtime-graph'
import type { AppState } from '../store/types'

// Why: getBrowserTabsByWorktree reads this slice once per worktree inside the build loop,
// so a counting accessor measures per-worktree work deterministically (no timing flake).
function makeCountingState(worktreeCount: number): {
  state: AppState
  reads: () => number
  resetReads: () => void
} {
  let reads = 0
  const tabsByWorktree: Record<string, unknown[]> = {}
  for (let i = 0; i < worktreeCount; i++) {
    tabsByWorktree[`repo::/wt-${i}`] = [
      { id: `term-${i}`, title: `Agent ${i}`, customTitle: null, type: 'terminal' }
    ]
  }

  const state = {
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    get browserTabsByWorktree() {
      reads++
      return {}
    }
  } as unknown as AppState

  return {
    state,
    reads: () => reads,
    resetReads: () => {
      reads = 0
    }
  }
}

// Why: tab.title is read only while a worktree's snapshot content is built, so a counting
// getter measures rebuilds rather than reads — the reads above survive a cheap hoist alone.
function makeTitleCountingState(worktreeCount: number): {
  state: AppState
  titleReads: () => number
  resetTitleReads: () => void
  withOneAgentStatusChanged: () => AppState
} {
  let titleReads = 0
  const leafIdFor = (index: number): string =>
    `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
  const makeTab = (index: number, label: string): unknown => ({
    id: `title-term-${index}`,
    customTitle: null,
    ptyId: null,
    get title() {
      titleReads++
      return label
    }
  })

  const tabsByWorktree: Record<string, unknown[]> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  for (let i = 0; i < worktreeCount; i++) {
    tabsByWorktree[`repo::/title-wt-${i}`] = [makeTab(i, `Agent ${i}`)]
    terminalLayoutsByTabId[`title-term-${i}`] = {
      root: { type: 'leaf', leafId: leafIdFor(i) },
      activeLeafId: leafIdFor(i),
      expandedLeafId: null
    }
  }
  const changedPaneKey = `title-term-7:${leafIdFor(7)}`
  const agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {
    [changedPaneKey]: {
      state: 'working',
      prompt: 'Investigate publication pressure',
      updatedAt: 1_700_000_000_000,
      stateStartedAt: 1_699_999_999_000,
      agentType: 'codex',
      paneKey: changedPaneKey,
      terminalTitle: 'codex [working]',
      stateHistory: []
    }
  }

  const state = {
    tabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey,
    browserTabsByWorktree: {}
  } as unknown as AppState

  return {
    state,
    titleReads: () => titleReads,
    resetTitleReads: () => {
      titleReads = 0
    },
    withOneAgentStatusChanged: () =>
      ({
        ...state,
        agentStatusByPaneKey: {
          ...agentStatusByPaneKey,
          [changedPaneKey]: {
            ...agentStatusByPaneKey[changedPaneKey],
            state: 'waiting',
            updatedAt: 1_700_000_001_000
          }
        }
      }) as unknown as AppState
  }
}

describe('mobile session publication cost', () => {
  it('does not redo per-worktree work when nothing changed', () => {
    const WORKTREES = 300
    const { state, reads, resetReads } = makeCountingState(WORKTREES)

    buildMobileSessionTabSnapshots(state)
    resetReads()

    // Same state object, no mutation: a republish should do no per-worktree work.
    buildMobileSessionTabSnapshots(state)

    expect(reads()).toBeLessThan(WORKTREES / 10)
  })

  it('rebuilds only the worktrees whose inputs changed', () => {
    const WORKTREES = 300
    const { state, reads, resetReads } = makeCountingState(WORKTREES)

    buildMobileSessionTabSnapshots(state)
    resetReads()

    // One worktree's tabs change — the other 299 are untouched.
    const next = {
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'repo::/wt-7': [
          { id: 'term-7', title: 'Agent 7 (done)', customTitle: null, type: 'terminal' }
        ]
      },
      get browserTabsByWorktree() {
        return (state as unknown as { browserTabsByWorktree: unknown }).browserTabsByWorktree
      }
    } as unknown as AppState

    buildMobileSessionTabSnapshots(next)

    expect(reads()).toBeLessThan(WORKTREES / 10)
  })

  it('builds no worktree content when nothing changed', () => {
    const { state, titleReads, resetTitleReads } = makeTitleCountingState(300)

    buildMobileSessionTabSnapshots(state)
    expect(titleReads()).toBeGreaterThan(0)
    resetTitleReads()

    buildMobileSessionTabSnapshots(state)

    expect(titleReads()).toBe(0)
  })

  it('builds content only for the worktree whose agent status changed', () => {
    const WORKTREES = 300
    const { state, titleReads, resetTitleReads, withOneAgentStatusChanged } =
      makeTitleCountingState(WORKTREES)

    const beforeByWorktree = new Map(
      buildMobileSessionTabSnapshots(state).map((snapshot) => [snapshot.worktree, snapshot])
    )
    const fullBuildReads = titleReads()
    resetTitleReads()

    const afterByWorktree = new Map(
      buildMobileSessionTabSnapshots(withOneAgentStatusChanged()).map((snapshot) => [
        snapshot.worktree,
        snapshot
      ])
    )
    const rebuiltWorktrees = [...afterByWorktree]
      .filter(([worktreeId, snapshot]) => snapshot !== beforeByWorktree.get(worktreeId))
      .map(([worktreeId]) => worktreeId)

    expect(titleReads()).toBeGreaterThan(0)
    expect(titleReads()).toBeLessThan(fullBuildReads / WORKTREES + 1)
    expect(rebuiltWorktrees).toEqual(['repo::/title-wt-7'])
  })
})

// Distinct ids per test: the snapshot memo is module state shared in this file.
const MOUNTED_WT = 'repo::/mounted-wt-0'
const CONTROL_WT = 'repo::/mounted-wt-1'
const MOUNTED_LEAF_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SPLIT_LEAF_ID = 'bbbbbbbb-1111-4111-8111-111111111111'

function makeMountedState(tabIdPrefix: string): {
  state: AppState
  mountedTabId: string
  titleReads: () => number
  resetTitleReads: () => void
} {
  let titleReads = 0
  const mountedTabId = `${tabIdPrefix}-term-0`
  const state = {
    tabsByWorktree: {
      [MOUNTED_WT]: [
        {
          id: mountedTabId,
          customTitle: null,
          ptyId: null,
          get title() {
            titleReads++
            return 'Agent mounted'
          }
        }
      ],
      [CONTROL_WT]: [
        { id: `${tabIdPrefix}-term-1`, title: 'Agent control', customTitle: null, ptyId: null }
      ]
    },
    terminalLayoutsByTabId: {
      [mountedTabId]: {
        root: { type: 'leaf', leafId: MOUNTED_LEAF_ID },
        activeLeafId: MOUNTED_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [MOUNTED_LEAF_ID]: 'pty-saved-1' }
      }
    },
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {}
  } as unknown as AppState
  return {
    state,
    mountedTabId,
    titleReads: () => titleReads,
    resetTitleReads: () => {
      titleReads = 0
    }
  }
}

function makeLiveSurface(tabId: string): {
  registration: Parameters<typeof registerRuntimeTerminalTab>[0]
  setPtyId: (paneId: number, ptyId: string) => void
  addPane: (paneId: number, leafId: string) => void
} {
  const panes = [{ id: 1, leafId: MOUNTED_LEAF_ID }]
  const ptyIdByPaneId = new Map<number, string | null>([[1, 'pty-live-1']])
  const manager = {
    getPanes: () => panes.map((pane) => ({ ...pane })),
    getActivePane: () => panes[0] ?? null,
    getLeafId: (paneId: number) => panes.find((pane) => pane.id === paneId)?.leafId ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      panes.find((pane) => pane.leafId === leafId)?.id ?? null
  }
  const registration = {
    tabId,
    worktreeId: MOUNTED_WT,
    getManager: () => manager,
    getContainer: () => null,
    getPtyIdForPane: (paneId: number) => ptyIdByPaneId.get(paneId) ?? null
  } as unknown as Parameters<typeof registerRuntimeTerminalTab>[0]
  return {
    registration,
    setPtyId: (paneId, ptyId) => {
      ptyIdByPaneId.set(paneId, ptyId)
    },
    addPane: (paneId, leafId) => {
      panes.push({ id: paneId, leafId })
      ptyIdByPaneId.set(paneId, `pty-live-${paneId}`)
    }
  }
}

function snapshotsByWorktree(
  state: AppState
): Map<string, ReturnType<typeof buildMobileSessionTabSnapshots>[number]> {
  return new Map(
    buildMobileSessionTabSnapshots(state).map((snapshot) => [snapshot.worktree, snapshot])
  )
}

describe('mounted terminal surface memoization', () => {
  it('reuses a mounted worktree snapshot when its live pane state is unchanged', () => {
    const { state, mountedTabId, titleReads, resetTitleReads } = makeMountedState('mounted-a')
    const unregister = registerRuntimeTerminalTab(makeLiveSurface(mountedTabId).registration)
    try {
      const before = snapshotsByWorktree(state)
      resetTitleReads()

      const after = snapshotsByWorktree(state)

      expect(titleReads()).toBe(0)
      expect(after.get(MOUNTED_WT)).toBe(before.get(MOUNTED_WT))
    } finally {
      unregister()
    }
  })

  it('publishes a live pty rebinding on a mounted worktree', () => {
    const { state, mountedTabId } = makeMountedState('mounted-b')
    const surface = makeLiveSurface(mountedTabId)
    const unregister = registerRuntimeTerminalTab(surface.registration)
    try {
      const before = snapshotsByWorktree(state)

      surface.setPtyId(1, 'pty-live-2')
      const after = snapshotsByWorktree(state)

      expect(after.get(MOUNTED_WT)).not.toBe(before.get(MOUNTED_WT))
      expect(after.get(MOUNTED_WT)?.tabs).toEqual([
        expect.objectContaining({ ptyId: 'pty-live-2' })
      ])
      expect(after.get(CONTROL_WT)).toBe(before.get(CONTROL_WT))
    } finally {
      unregister()
    }
  })

  it('publishes a live pane split on a mounted worktree', () => {
    const { state, mountedTabId } = makeMountedState('mounted-c')
    const surface = makeLiveSurface(mountedTabId)
    const unregister = registerRuntimeTerminalTab(surface.registration)
    try {
      snapshotsByWorktree(state)

      surface.addPane(2, SPLIT_LEAF_ID)
      const after = snapshotsByWorktree(state)

      expect(
        after.get(MOUNTED_WT)?.tabs.map((tab) => (tab.type === 'terminal' ? tab.leafId : null))
      ).toEqual([MOUNTED_LEAF_ID, SPLIT_LEAF_ID])
    } finally {
      unregister()
    }
  })

  it('falls back to the persisted pty binding after the surface unmounts', () => {
    const { state, mountedTabId, titleReads, resetTitleReads } = makeMountedState('mounted-d')
    const unregister = registerRuntimeTerminalTab(makeLiveSurface(mountedTabId).registration)
    snapshotsByWorktree(state)

    unregister()
    resetTitleReads()
    const after = snapshotsByWorktree(state)

    expect(titleReads()).toBeGreaterThan(0)
    expect(after.get(MOUNTED_WT)?.tabs).toEqual([expect.objectContaining({ ptyId: 'pty-saved-1' })])
  })
})
