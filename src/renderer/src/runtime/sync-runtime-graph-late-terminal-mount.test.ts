import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'
import { buildMobileSessionTabSnapshots, registerRuntimeTerminalTab } from './sync-runtime-graph'
import { graphState } from './sync-runtime-graph/graph-state'
import { resetPublicationCaches } from './sync-runtime-graph-worktree-source-gate.test-support'

/**
 * Mounting a TerminalPane writes to the registry, not to the store. A worktree whose snapshot was
 * cached while it had no mounted pane therefore has a byte-identical source fingerprint on the
 * publication right after the mount, and the fast path's only defence is that it asks the registry
 * directly. Without that question the worktree publishes its pre-mount snapshot — and because the
 * fast path returns before refreshing the cache entry, it keeps publishing it.
 */

const LEAF_ID = 'aaaaaaaa-2222-4222-8222-222222222222'
const LATE_WT = 'repo::/late-mount'
const TAB_ID = 'late-mount-term'
const SAVED_PTY = 'pty-late-mount-saved'
const LIVE_PTY = 'pty-late-mount-live'
const PANE_ID = 7

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeLayout(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

function makeLateMountState(): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path reads only the slices assigned here; a full AppState is not constructible in a unit test.
  return {
    tabsByWorktree: { [LATE_WT]: [makeTab(TAB_ID, LATE_WT)] },
    terminalLayoutsByTabId: { [TAB_ID]: makeLayout(SAVED_PTY) },
    runtimePaneTitlesByTabId: {},
    nativeChatLaunchDraftByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabType: null,
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    worktreesByRepo: {},
    folderWorkspaces: [],
    settings: { tabAutoGenerateTitle: false }
  } as unknown as AppState
}

/** A single-pane manager, as a freshly mounted TerminalPane presents itself. */
function mountTerminalPane(): () => void {
  const pane = { id: PANE_ID, leafId: LEAF_ID }
  const manager = {
    getPanes: () => [{ ...pane }],
    getActivePane: () => pane,
    getLeafId: (paneId: number) => (paneId === pane.id ? pane.leafId : null),
    getNumericIdForLeaf: (leafId: string) => (leafId === pane.leafId ? pane.id : null)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path calls only the PaneManager members stubbed above.
  return registerRuntimeTerminalTab({
    tabId: TAB_ID,
    worktreeId: LATE_WT,
    getManager: () => manager,
    getContainer: () => null,
    getPtyIdForPane: (paneId: number) => (paneId === PANE_ID ? LIVE_PTY : null),
    getTabWideAgentHintLeafId: () => LEAF_ID
  } as unknown as Parameters<typeof registerRuntimeTerminalTab>[0])
}

/** The published pty for the worktree's only terminal surface: saved before mount, live after. */
function publishPtyId(state: AppState): string | null | undefined {
  const tab = buildMobileSessionTabSnapshots(state, false).find(
    (snapshot) => snapshot.worktree === LATE_WT
  )?.tabs[0]
  return tab?.type === 'terminal' ? tab.ptyId : undefined
}

beforeEach(resetPublicationCaches)

describe('a TerminalPane that mounts after its worktree was cached', () => {
  it('republishes the worktree even though no store slice moved', () => {
    const state = makeLateMountState()

    expect(publishPtyId(state)).toBe(SAVED_PTY)

    const unmount = mountTerminalPane()
    try {
      expect(publishPtyId(state)).toBe(LIVE_PTY)
    } finally {
      unmount()
    }
  })

  it('does not strand the worktree on the pre-mount snapshot for every later publication', () => {
    const state = makeLateMountState()
    buildMobileSessionTabSnapshots(state, false)

    const unmount = mountTerminalPane()
    try {
      expect([publishPtyId(state), publishPtyId(state), publishPtyId(state)]).toEqual([
        LIVE_PTY,
        LIVE_PTY,
        LIVE_PTY
      ])
      // The staleness is permanent because a skipped publication never refreshes the entry the
      // next one is gated on; assert the mount reached the cache, not only the wire.
      expect(
        graphState.mobileSessionSnapshotCacheByWorktree.get(LATE_WT)?.inputs
          .mountedSurfaceCaptureByTabId.size
      ).toBe(1)
    } finally {
      unmount()
    }
  })

  it('republishes the worktree again once the pane unmounts', () => {
    const state = makeLateMountState()
    const unmount = mountTerminalPane()
    try {
      expect(publishPtyId(state)).toBe(LIVE_PTY)
    } finally {
      unmount()
    }

    expect(publishPtyId(state)).toBe(SAVED_PTY)
  })
})
