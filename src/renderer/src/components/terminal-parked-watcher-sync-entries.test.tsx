// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from './use-terminal-watcher-effects'
import type { ParkedTerminalTabWatcherSyncEntry } from './terminal-pane/terminal-parked-tab-watchers'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

type WatcherController = Parameters<typeof useTerminalWatcherEffects>[0]

const mocks = vi.hoisted(() => ({
  sync: vi.fn<(entries: Map<string, ParkedTerminalTabWatcherSyncEntry>) => void>(),
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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

function terminalTab(id: string, worktreeId: string, ptyId: string | null = null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function renderWatcherEffects(overrides: Partial<WatcherController> = {}): Promise<void> {
  const controller: WatcherController = {
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeView: 'terminal',
    activeWorktreeId: null,
    activityTerminalPortals: [],
    anyMountedWorktreeHasLayout: false,
    backgroundMountRevision: 0,
    createTab: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(),
    pairedRuntimeParkingEnvironmentIds: new Set(),
    terminalSshParkingEnabled: true,
    terminalProviderSnapshotCapabilityRevision: 0,
    effectiveParkedTerminalWorktreeIds: new Set([PARKED_WORKTREE_ID]),
    evictionExemptTerminalTabIds: new Set(['tab-exempt']),
    getEffectiveLayoutForWorktree: () => undefined,
    groupsByWorktree: {},
    hydrationSucceeded: false,
    measurableBackgroundWorktreeIdsRef: { current: new Set() },
    mountedWorktreeIdsRef: { current: new Set([PARKED_WORKTREE_ID]) },
    pendingStartupByTabId: {},
    // Another workspace is on screen, so the mounted one is hidden and parks.
    renderedActiveWorktreeId: 'repo-1::/worktree-9',
    tabsByWorktree: {
      [PARKED_WORKTREE_ID]: [
        terminalTab('tab-parked', PARKED_WORKTREE_ID),
        terminalTab('tab-exempt', PARKED_WORKTREE_ID)
      ]
    },
    terminalParkingEnabled: true,
    terminalStartupRestorationReady: false,
    terminalTitleSnapshotAuthorityEnabled: true,
    workspaceSessionReady: false,
    workspaceSurfaceIds: surfaceIds,
    ...overrides
  }
  function Watcher(): null {
    useTerminalWatcherEffects({ ...controller, ...overrides })
    return null
  }
  root = createRoot(document.createElement('div'))
  rerenderWatcher = () => act(async () => root?.render(<Watcher />))
  return rerenderWatcher()
}

function lastSyncEntries(): Map<string, ParkedTerminalTabWatcherSyncEntry> {
  const entries = mocks.sync.mock.calls.at(-1)?.[0]
  if (!entries) {
    throw new Error('Expected watcher synchronization')
  }
  return entries
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
      const tab = terminalTab('background-agent', workspaceId, 'live-pty')
      await renderWatcherEffects({
        anyMountedWorktreeHasLayout: true,
        workspaceSurfaceIds: [...surfaceIds, workspaceId],
        tabsByWorktree: { [workspaceId]: [tab] }
      })

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
      tabsByWorktree: { [surfaceIds[1]]: [terminalTab('unverifiable-tab', surfaceIds[1])] }
    })

    const entry = lastSyncEntries().get(surfaceIds[1])!
    expect(entry.parkedTabIds.size).toBe(0)
    expect(entry.restoreTitleOnStartTabIds).toBeUndefined()
  })
  it('starts watching when host snapshot capability resolves after tab admission', async () => {
    const overrides: Partial<WatcherController> = {
      terminalProviderSnapshotCapabilityRevision: 0,
      tabsByWorktree: {
        [surfaceIds[1]]: [terminalTab('background-agent', surfaceIds[1], 'live-pty')]
      }
    }
    mocks.canCover.mockReturnValue(false)
    await renderWatcherEffects(overrides)
    expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)

    mocks.canCover.mockReturnValue(true)
    overrides.terminalProviderSnapshotCapabilityRevision = 1
    await rerenderWatcher()

    expect([...lastSyncEntries().get(surfaceIds[1])!.parkedTabIds]).toEqual(['background-agent'])
  })

  it.each(['paired capability', 'SSH parking setting'])(
    'reconciles never-mounted remote tabs when %s changes',
    async (input) => {
      const overrides: Partial<WatcherController> = {
        pairedRuntimeParkingEnvironmentIds: new Set<string>(),
        terminalSshParkingEnabled: false,
        tabsByWorktree: {
          [surfaceIds[1]]: [terminalTab('remote-agent', surfaceIds[1], 'remote-pty')]
        }
      }
      mocks.canCover.mockReturnValue(false)
      await renderWatcherEffects(overrides)
      expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)

      mocks.canCover.mockReturnValue(true)
      if (input === 'paired capability') {
        overrides.pairedRuntimeParkingEnvironmentIds = new Set(['paired-host'])
      } else {
        overrides.terminalSshParkingEnabled = true
      }
      await rerenderWatcher()
      expect([...lastSyncEntries().get(surfaceIds[1])!.parkedTabIds]).toEqual(['remote-agent'])

      mocks.canCover.mockReturnValue(false)
      if (input === 'paired capability') {
        overrides.pairedRuntimeParkingEnvironmentIds = new Set()
      } else {
        overrides.terminalSshParkingEnabled = false
      }
      await rerenderWatcher()
      expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)
    }
  )

  it('leaves activity-portal terminals with their existing consumer', async () => {
    await renderWatcherEffects({
      tabsByWorktree: { [surfaceIds[1]]: [terminalTab('portal-agent', surfaceIds[1], 'live-pty')] },
      activityTerminalPortals: [
        {
          worktreeId: surfaceIds[1],
          tabId: 'portal-agent',
          slotId: 'slot',
          requestToken: 'request',
          target: document.createElement('div'),
          paneKey: 'pane',
          active: true
        }
      ]
    })

    expect(lastSyncEntries().get(surfaceIds[1])!.parkedTabIds.size).toBe(0)
  })
})
