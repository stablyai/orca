import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'
import { registerRuntimeTerminalTab } from '../hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import type { AppState } from '../../store/types'

// Distinct ids per test: the snapshot memo is module state shared in this file.
const MOUNTED_WT = 'repo::/mounted-wt-0'
const CONTROL_WT = 'repo::/mounted-wt-1'
const MOUNTED_LEAF_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SPLIT_LEAF_ID = 'bbbbbbbb-1111-4111-8111-111111111111'

function makeMountedState(tabIdPrefix: string): {
  state: AppState
  mountedTabId: string
} {
  const mountedTabId = `${tabIdPrefix}-term-0`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot publication reads only this fixture's populated state fields.
  const state = {
    tabsByWorktree: {
      [MOUNTED_WT]: [
        {
          id: mountedTabId,
          customTitle: null,
          ptyId: null,
          title: 'Agent mounted'
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
    mountedTabId
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this surface supplies the manager and PTY readers used by snapshot publication.
  const registration = {
    tabId,
    worktreeId: MOUNTED_WT,
    getManager: () => manager,
    getContainer: () => null,
    getPtyIdForPane: (paneId: number) => ptyIdByPaneId.get(paneId) ?? null,
    getTabWideAgentHintLeafId: () => MOUNTED_LEAF_ID
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
    const { state, mountedTabId } = makeMountedState('mounted-d')
    const unregister = registerRuntimeTerminalTab(makeLiveSurface(mountedTabId).registration)
    snapshotsByWorktree(state)

    unregister()
    const after = snapshotsByWorktree(state)

    expect(after.get(MOUNTED_WT)?.tabs).toEqual([expect.objectContaining({ ptyId: 'pty-saved-1' })])
  })
})
