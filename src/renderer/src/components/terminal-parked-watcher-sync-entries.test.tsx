// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from './use-terminal-watcher-effects'
import type { ParkedTerminalTabWatcherSyncEntry } from './terminal-pane/terminal-parked-tab-watchers'
import type { TerminalColdActivationController } from './terminal-cold-activation'

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  prune: vi.fn(),
  canCover: vi.fn(() => true)
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
  canWatcherCoverParkedTerminalTab: mocks.canCover,
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
let rerenderWatcher: () => Promise<void>
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
  mocks.canCover.mockReturnValue(true)
})

function renderWatcherEffects(
  overrides: Partial<TerminalColdActivationController> = {}
): Promise<void> {
  const controller = {
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
    workspaceSurfaceIds: surfaceIds,
    ...overrides
  } as unknown as TerminalColdActivationController
  function Watcher(): null {
    useTerminalWatcherEffects({ ...controller, ...overrides })
    return null
  }
  root = createRoot(document.createElement('div'))
  rerenderWatcher = () => act(async () => root?.render(<Watcher />))
  return rerenderWatcher()
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
  it.each(['repo-1::/never-visited', 'folder:never-visited'])(
    'watches a live terminal in never-activated workspace %s and restores its title',
    async (workspaceId) => {
      const tab = { id: 'background-agent', ptyId: 'live-pty' }
      await renderWatcherEffects({
        anyMountedWorktreeHasLayout: true,
        workspaceSurfaceIds: [...surfaceIds, workspaceId],
        tabsByWorktree: { [workspaceId]: [tab] }
      } as unknown as Partial<TerminalColdActivationController>)

      const entry = lastSyncEntries().get(workspaceId)
      expect([...entry!.parkedTabIds]).toEqual([tab.id])
      expect([...entry!.restoreTitleOnStartTabIds!]).toEqual([tab.id])
      expect(mocks.canCover).toHaveBeenCalledWith(workspaceId, tab)
      expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)
    }
  )

  it('does not watch a never-activated tab whose host cannot provide coverage', async () => {
    mocks.canCover.mockReturnValue(false)
    await renderWatcherEffects({
      tabsByWorktree: { [surfaceIds[1]]: [{ id: 'unverifiable-tab' }] }
    } as unknown as Partial<TerminalColdActivationController>)

    const entry = lastSyncEntries().get(surfaceIds[1])!
    expect(entry.parkedTabIds.size).toBe(0)
    expect(entry.restoreTitleOnStartTabIds).toBeUndefined()
  })
  it('starts watching when host snapshot capability resolves after tab admission', async () => {
    const overrides = {
      terminalProviderSnapshotCapabilityRevision: 0,
      tabsByWorktree: { [surfaceIds[1]]: [{ id: 'background-agent', ptyId: 'live-pty' }] }
    } as unknown as Partial<TerminalColdActivationController>
    mocks.canCover.mockReturnValue(false)
    await renderWatcherEffects(overrides)
    expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)

    mocks.canCover.mockReturnValue(true)
    overrides.terminalProviderSnapshotCapabilityRevision = 1
    await rerenderWatcher()

    expect([...lastSyncEntries().get(surfaceIds[1])!.parkedTabIds]).toEqual(['background-agent'])
  })

  it('leaves activity-portal terminals with their existing consumer', async () => {
    await renderWatcherEffects({
      tabsByWorktree: { [surfaceIds[1]]: [{ id: 'portal-agent', ptyId: 'live-pty' }] },
      activityTerminalPortals: [{ worktreeId: surfaceIds[1], tabId: 'portal-agent' }]
    } as unknown as Partial<TerminalColdActivationController>)

    expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)
  })
})
