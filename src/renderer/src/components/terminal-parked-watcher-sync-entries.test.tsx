// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from './use-terminal-watcher-effects'
import type { ParkedTerminalTabWatcherSyncEntry } from './terminal-pane/terminal-parked-tab-watchers'
import type { TerminalColdActivationController } from './terminal-cold-activation'

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  prune: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => 'unverifiable', {
    getState: () => ({ activeWorktreeId: null })
  })
}))
vi.mock('@/lib/workspace-terminal-host-authority', () => ({
  createWorkspaceTerminalHostAuthoritySelector: () => () => 'unverifiable'
}))
vi.mock('./terminal-pane/terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeAllParkedTerminalWatchers: vi.fn(),
  pruneParkedTerminalWatchers: mocks.prune,
  syncParkedTerminalTabWatchersForWorkspaces: mocks.sync,
  terminalWatcherLiveWorkspaceIds: (ids: Iterable<string>) => new Set(ids)
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SURFACE_COUNT = 423
const PARKED_WORKTREE_ID = 'repo-1::/worktree-0'
const surfaceIds = Array.from({ length: SURFACE_COUNT }, (_, index) => `repo-1::/worktree-${index}`)

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
})

function renderWatcherEffects(): Promise<void> {
  function Watcher(): null {
    useTerminalWatcherEffects({
      activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
      activeTabId: null,
      activeTabIdByWorktree: {},
      activeView: 'terminal',
      activeWorktreeId: null,
      activityTerminalPortals: [],
      anyMountedWorktreeHasLayout: false,
      backgroundMountRevision: 0,
      effectiveParkedTerminalWorktreeIds: new Set([PARKED_WORKTREE_ID]),
      evictionExemptTerminalTabIds: new Set(['tab-exempt']),
      getEffectiveLayoutForWorktree: () => null,
      groupsByWorktree: {},
      hydrationSucceeded: false,
      measurableBackgroundWorktreeIdsRef: { current: new Set() },
      mountedWorktreeIdsRef: { current: new Set([PARKED_WORKTREE_ID]) },
      pendingStartupByTabId: {},
      // Another workspace is on screen, so the mounted one is hidden and parks.
      renderedActiveWorktreeId: 'repo-1::/worktree-9',
      tabsByWorktree: {
        [PARKED_WORKTREE_ID]: [{ id: 'tab-parked' }, { id: 'tab-exempt' }]
      },
      terminalParkingEnabled: true,
      terminalStartupRestorationReady: false,
      terminalTitleSnapshotAuthorityEnabled: true,
      workspaceSessionReady: false,
      workspaceSurfaceIds: surfaceIds
    } as unknown as TerminalColdActivationController)
    return null
  }
  root = createRoot(document.createElement('div'))
  return act(async () => root?.render(<Watcher />))
}

function lastSyncEntries(): Map<string, ParkedTerminalTabWatcherSyncEntry> {
  return mocks.sync.mock.calls.at(-1)?.[0] as Map<string, ParkedTerminalTabWatcherSyncEntry>
}

describe('parked terminal watcher sync entries', () => {
  it('publishes an entry for every surface so closed-tab disposal still sees it', async () => {
    await renderWatcherEffects()

    const entries = lastSyncEntries()
    expect(entries.size).toBe(SURFACE_COUNT)
    expect([...entries.keys()]).toEqual(surfaceIds)
    expect(mocks.prune).toHaveBeenCalledWith(new Set(surfaceIds))
  })

  it('parks the hidden mounted workspace tabs and exempts the eviction-exempt tab', async () => {
    await renderWatcherEffects()

    const parkedEntry = lastSyncEntries().get(PARKED_WORKTREE_ID)
    expect([...(parkedEntry?.parkedTabIds ?? [])]).toEqual(['tab-parked'])
  })

  it('does not allocate a parked-tab-id set per unmounted surface', async () => {
    await renderWatcherEffects()

    const entries = lastSyncEntries()
    const unmountedSets = new Set(
      [...entries]
        .filter(([workspaceId]) => workspaceId !== PARKED_WORKTREE_ID)
        .map(([, entry]) => entry.parkedTabIds)
    )
    // Pre-fix this was one empty Set per surface (422 of them) on every fire.
    expect(unmountedSets.size).toBe(1)
    expect([...unmountedSets][0]?.size).toBe(0)
  })
})
