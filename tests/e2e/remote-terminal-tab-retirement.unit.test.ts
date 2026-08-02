import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../src/shared/runtime-types'
import type { WorkspaceSessionState } from '../../src/shared/types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  shouldApplyWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from '../../src/renderer/src/runtime/web-session-tabs-sync'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: { setState: vi.fn() }
}))

const WORKTREE_ID = 'repo::/remote-worktree'
const TAB_ID = 'host-terminal'
const LEAF_ID = 'terminal-leaf'
const PTY_ID = 'remote-pty'
const INCARNATION_ID = 'remote-pty-incarnation'
const VIEWER_IDS = ['paired-desktop-a', 'paired-desktop-b'] as const

function makeViewerState(): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WORKTREE_ID,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0
  }
}

function makeHostSnapshot(): RuntimeMobileSessionTabsSnapshot {
  const parentLayout = {
    root: { type: 'leaf' as const, leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
  }
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'host-publication',
    snapshotVersion: 1,
    activeGroupId: 'host-group',
    activeTabId: `${TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'host-group', activeTabId: TAB_ID, tabOrder: [TAB_ID] }],
    tabs: [
      {
        type: 'terminal',
        id: `${TAB_ID}::${LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: PTY_ID,
        title: 'Pinned remote agent',
        launchAgent: 'claude',
        isPinned: true,
        parentLayout,
        isActive: true
      }
    ]
  }
}

function makePersistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Pinned remote agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          isPinned: true
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    sleepingAgentSessionsByPaneKey: { [`${TAB_ID}:${LEAF_ID}`]: {} as never }
  }
}

function reconcileViewer(
  state: WebSessionTabsSyncState,
  snapshot: Parameters<typeof applyWebSessionTabsSnapshot>[1],
  viewerId: string
): WebSessionTabsSyncState {
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, viewerId) }
}

describe('remote terminal tab retirement publication', () => {
  beforeEach(() => resetWebSessionTabsSnapshotFreshnessForTests())

  it('removes a permanent host exit from simultaneous viewers without stale resurrection', async () => {
    let session = makePersistedSession()
    const flushOrThrow = vi.fn()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next) => {
        session = next
      },
      flushOrThrow
    } as never)
    runtime.attachWindow(1)
    const staleLiveSnapshot = makeHostSnapshot()
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Pinned remote agent',
          activeLeafId: LEAF_ID,
          layout: { type: 'leaf', leafId: LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_ID
        }
      ],
      mobileSessionTabs: [staleLiveSnapshot]
    })
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID
    })

    const livePublication = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const viewerStates = new Map<string, WebSessionTabsSyncState>()
    for (const viewerId of VIEWER_IDS) {
      expect(shouldApplyWebSessionTabsSnapshot(livePublication, viewerId)).toBe(true)
      viewerStates.set(viewerId, reconcileViewer(makeViewerState(), livePublication, viewerId))
    }
    expect(
      [...viewerStates.values()].every((state) => state.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId)
    ).toBe(true)

    const publications: (typeof livePublication)[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((event) => publications.push(event))
    runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID)
    const retiredPublication = publications.at(-1)
    expect(retiredPublication).toBeDefined()
    if (!retiredPublication) {
      throw new Error('host did not publish terminal retirement')
    }
    expect(publications).toHaveLength(1)
    expect(retiredPublication.publicationEpoch).toBe(livePublication.publicationEpoch)
    expect(retiredPublication.snapshotVersion).toBeGreaterThan(livePublication.snapshotVersion)
    expect(retiredPublication.tabs).toEqual([])
    expect(flushOrThrow).toHaveBeenCalledOnce()
    expect(session.tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(session.terminalLayoutsByTabId[TAB_ID]).toBeUndefined()

    for (const viewerId of VIEWER_IDS) {
      const current = viewerStates.get(viewerId)!
      expect(shouldApplyWebSessionTabsSnapshot(retiredPublication, viewerId)).toBe(true)
      const retired = reconcileViewer(current, retiredPublication, viewerId)
      expect(retired.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
      expect(shouldApplyWebSessionTabsSnapshot(livePublication, viewerId)).toBe(false)

      acceptReplayedWebSessionTabsSnapshot(viewerId, WORKTREE_ID)
      expect(shouldApplyWebSessionTabsSnapshot(livePublication, viewerId)).toBe(false)
      expect(shouldApplyWebSessionTabsSnapshot(retiredPublication, viewerId)).toBe(true)
      const replayed = reconcileViewer(retired, retiredPublication, viewerId)
      expect(replayed.tabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
      expect(shouldApplyWebSessionTabsSnapshot(livePublication, viewerId)).toBe(false)
    }
    unsubscribe()
  })
})
