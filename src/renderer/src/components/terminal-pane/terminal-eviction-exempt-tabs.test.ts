/**
 * Which parked tabs force-park must leave mounted.
 *
 * Sits beside terminal-parked-tab-watchers.test.ts because the exemption reads the same captured
 * pane candidates that watcher coverage does — a split tab that fails coverage must be exempt, or
 * force-park unmounts the live pty the exemption exists to protect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

vi.mock('./parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: vi.fn(() => vi.fn())
}))
vi.mock('./pty-dispatcher', () => ({
  subscribeToPtyExit: vi.fn(() => vi.fn())
}))
vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: vi.fn(),
  hasPreHandlerPtyExit: () => false
}))

type MockStoreState = {
  tabsByWorktree: Record<string, { id: string; ptyId: string | null }[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: unknown
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** Transport ownership the exemption compares a remote pty id's owner against. */
  worktreesByRepo: Record<string, { id: string; repoId: string; hostId: string }[]>
  repos: { id: string; connectionId: string | null }[]
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: { capabilities?: string[] } | null; checkedAt: number }
  >
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  setTabLayout: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

import {
  isEvictionExemptTerminalTab,
  selectEvictionExemptTerminalTabIds
} from './terminal-eviction-exempt-tabs'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  canWatcherCoverParkedTerminalTab,
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers
} from './terminal-parked-tab-watchers'

function capturePanes(
  panes: { ptyId: string | null; paneId: number; leafId: string; drivesTabTitle: boolean }[]
): void {
  captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, panes)
}

describe('isEvictionExemptTerminalTab', () => {
  beforeEach(async () => {
    mockStoreState = {
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      worktreesByRepo: { repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId: 'local' }] },
      repos: [{ id: 'repo', connectionId: null }],
      settings: null,
      runtimeStatusByEnvironmentId: new Map(),
      clearRuntimePaneTitle: vi.fn(),
      setRuntimePaneTitle: vi.fn(),
      setTabLayout: vi.fn()
    }
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID, SECOND_PTY_ID], async (ids) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
  })

  afterEach(() => {
    // Module-level registries persist across tests; clear them through the
    // public prune path so each test starts from an empty parked state.
    pruneParkedTerminalWatchers(new Set())
    vi.clearAllMocks()
    clearTerminalProviderSnapshotCapabilities()
  })

  // Why these pair with coverage: the same split tab that fails coverage (so
  // force-park targets its worktree) must be exempt, or force-park unmounts
  // the very live pty the exemption exists to protect.
  it('exempts a split tab whose SECOND pane holds the unrestorable pty', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'other::wt@@session-9', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    const tab = { id: TAB_ID, ptyId: PTY_ID }
    expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, tab)).toBe(false)
    expect(isEvictionExemptTerminalTab(tab, WORKTREE_ID)).toBe(true)
  })

  // Why: locks the documented residual — detection is per pane, retention is
  // per tab, so the snapshot-backed first leaf is pinned by its fail-open
  // sibling instead of parking on its own.
  it('exempts a split tab even when its other leaf is snapshot-backed', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      // Why separator-less: the daemon-fail-open class, restorable by nothing.
      { ptyId: 'pty-local-detached', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(true)
  })

  it('exempts a split tab whose second leaf pty comes from the layout fallback', () => {
    mockStoreState.terminalLayoutsByTabId[TAB_ID] = {
      root: {
        type: 'split',
        direction: 'row',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: SECOND_LEAF_ID }
      },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: 'pty-local-detached' }
    }
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(true)
  })

  it('does not exempt a split tab whose panes are all snapshot-backed', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(false)
  })

  it('exempts a preserved daemon whose snapshot is not authoritative', async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], async () => [
      { id: PTY_ID, authoritative: false }
    ])
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])

    const tab = { id: TAB_ID, ptyId: PTY_ID }
    expect(canWatcherCoverParkedTerminalTab(WORKTREE_ID, tab)).toBe(false)
    expect(isEvictionExemptTerminalTab(tab, WORKTREE_ID)).toBe(true)
  })

  it('exempts on tab.ptyId alone when no panes resolve', () => {
    expect(
      isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: 'pty-local-detached' }, WORKTREE_ID)
    ).toBe(true)
  })

  it('exempts remote-runtime or SSH panes without authoritative ownership', () => {
    capturePanes([
      { ptyId: 'remote:env-1@@t-1', paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'ssh:conn-1@@pty-1', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: null }, WORKTREE_ID)).toBe(true)
  })

  describe('selectEvictionExemptTerminalTabIds', () => {
    it('collects only the exempt tabs of one worktree in a single pass', () => {
      expect(
        selectEvictionExemptTerminalTabIds(WORKTREE_ID, [
          { id: TAB_ID, ptyId: 'pty-local-detached' },
          { id: 'tab-restorable', ptyId: PTY_ID }
        ])
      ).toEqual(new Set([TAB_ID]))
    })
  })
})
