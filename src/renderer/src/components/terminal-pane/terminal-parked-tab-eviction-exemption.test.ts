import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WORKTREE_ID = 'repo::/worktree'
const TAB_ID = 'tab-1'
const PTY_ID = `${WORKTREE_ID}@@session-1`
const SECOND_PTY_ID = `${WORKTREE_ID}@@session-2`
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type MockStoreState = {
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
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: Map<
    string,
    { status: { capabilities?: readonly string[] } | null; checkedAt: number }
  >
}

let mockStoreState: MockStoreState
const preHandlerExitPtyIds = new Set<string>()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))

vi.mock('./terminal-parked-pty-watcher', () => ({
  collapseParkedExitedLeaf: vi.fn(),
  startParkedPtyWatcher: vi.fn()
}))

vi.mock('./pty-pre-handler-buffer', () => ({
  discardPreHandlerPtyState: vi.fn(),
  hasPreHandlerPtyExit: (ptyId: string) => preHandlerExitPtyIds.has(ptyId)
}))

import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  captureParkedTerminalPaneCandidates,
  pruneParkedTerminalWatchers
} from './terminal-parked-tab-watchers'
import {
  isEvictionExemptTerminalTab,
  selectEvictionExemptTerminalTabIds
} from './terminal-eviction-exempt-tabs'

function capturePanes(
  panes: { ptyId: string | null; paneId: number; leafId: string; drivesTabTitle: boolean }[]
): void {
  captureParkedTerminalPaneCandidates(TAB_ID, WORKTREE_ID, panes)
}

function splitLayout(secondPtyId: string): MockStoreState['terminalLayoutsByTabId'][string] {
  return {
    root: {
      type: 'split',
      direction: 'row',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SECOND_LEAF_ID }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [SECOND_LEAF_ID]: secondPtyId }
  }
}

describe('parked terminal tab eviction exemption', () => {
  beforeEach(async () => {
    mockStoreState = {
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      settings: null,
      runtimeStatusByEnvironmentId: new Map()
    }
    preHandlerExitPtyIds.clear()
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID, SECOND_PTY_ID], async (ids) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
  })

  afterEach(() => {
    preHandlerExitPtyIds.clear()
    pruneParkedTerminalWatchers(new Set())
    clearTerminalProviderSnapshotCapabilities()
  })

  it('exempts a split tab whose second pane holds an unrestorable pty', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'other::wt@@session-9', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    const tab = { id: TAB_ID, ptyId: PTY_ID }
    expect(isEvictionExemptTerminalTab(tab, WORKTREE_ID)).toBe(true)
  })

  it('keeps a split tab exempt when its other leaf is snapshot-backed', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'pty-local-detached', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(true)
  })

  it('resolves the exemption from a layout-derived second leaf', () => {
    mockStoreState.terminalLayoutsByTabId[TAB_ID] = splitLayout('pty-local-detached')
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(true)
  })

  it('does not exempt a split tab whose panes are all snapshot-backed', () => {
    capturePanes([
      { ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: SECOND_PTY_ID, paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(false)
  })

  it('exempts a preserved daemon while snapshot capability is unknown', async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([PTY_ID], async () => [
      { id: PTY_ID, authoritative: false }
    ])
    capturePanes([{ ptyId: PTY_ID, paneId: 1, leafId: LEAF_ID, drivesTabTitle: true }])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: PTY_ID }, WORKTREE_ID)).toBe(true)
  })

  it('exempts a tab from its tab-level pty when no panes resolve', () => {
    expect(
      isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: 'pty-local-detached' }, WORKTREE_ID)
    ).toBe(true)
  })

  it('does not exempt remote-runtime or SSH panes', () => {
    capturePanes([
      { ptyId: 'remote:env-1@@t-1', paneId: 1, leafId: LEAF_ID, drivesTabTitle: true },
      { ptyId: 'ssh:conn-1@@pty-1', paneId: 2, leafId: SECOND_LEAF_ID, drivesTabTitle: false }
    ])
    expect(isEvictionExemptTerminalTab({ id: TAB_ID, ptyId: null }, WORKTREE_ID)).toBe(false)
  })

  it('selects only exempt tabs in one worktree pass', () => {
    expect(
      selectEvictionExemptTerminalTabIds(WORKTREE_ID, [
        { id: TAB_ID, ptyId: 'pty-local-detached' },
        { id: 'tab-restorable', ptyId: PTY_ID }
      ])
    ).toEqual(new Set([TAB_ID]))
  })
})
