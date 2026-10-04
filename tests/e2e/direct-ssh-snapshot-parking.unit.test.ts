// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { createElement, Fragment, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportRemoteWorkspaceSession } from '../../src/shared/remote-workspace-session-projection'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSnapshot
} from '../../src/shared/remote-workspace-types'
import {
  resyncStaleRemoteWorkspace,
  _resetRemoteWorkspaceStaleResyncForTests
} from '../../src/main/ipc/remote-workspace-stale-resync'
import {
  clearRemoteWorkspaceSnapshotCache,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from '../../src/main/ipc/remote-workspace-snapshot-cache'
import type { DirectSshAuthority, SshProviderEpoch, SshTarget } from '../../src/shared/ssh-types'
import { useAppStore } from '@/store'
import { makeTerminalTab, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { applyDirectSshRemoteWorkspaceSnapshot } from '@/hooks/remote-workspace-snapshot-apply'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import { selectColdParkedTerminalWorktrees } from '@/components/terminal-pane/terminal-hidden-view-parking'
import {
  canWatcherCoverParkedTerminalTab,
  disposeAllParkedTerminalWatchers
} from '@/components/terminal-pane/terminal-parked-tab-watchers'
import { useTerminalTabColdParking } from '@/components/terminal-pane/use-terminal-tab-cold-parking'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock('../../src/main/ipc/ssh', () => ({
  getActiveMultiplexer: () => ({ request })
}))

vi.mock('@/components/terminal-pane/parked-terminal-byte-watcher', () => ({
  startParkedTerminalByteWatcher: () => () => {}
}))

const START_MS = 1_000_000
const TARGET_ID = 'ssh-parking-host'
const TARGET: SshTarget = {
  id: TARGET_ID,
  label: 'SSH',
  host: 'example.test',
  port: 22,
  username: 'dev'
}
const ptyIdFor = (tabId: string): string => `ssh:${TARGET_ID}@@${tabId}`
const WORKTREE_ID = 'repo-ssh::/work/ssh-parking'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TABS = ['tab-a', 'tab-b'].map((id) =>
  makeTerminalTab({ id, worktreeId: WORKTREE_ID, ptyId: ptyIdFor(id) })
)
const ASSIGNMENTS = new Map<string, { groupId: string; isActiveInGroup: boolean }>()
const PORTALS: never[] = []
const mounts = new Map<string, number>()
const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: main-issued opaque tokens are stable strings; this fixture models one unchanged provider incarnation.
  providerEpoch: 'parking-provider' as SshProviderEpoch,
  connectionGeneration: 1
}
let parkedTabIds: ReadonlySet<string> = new Set()

function AttachedPane({ tabId }: { tabId: string }): null {
  useEffect(() => {
    mounts.set(tabId, (mounts.get(tabId) ?? 0) + 1)
    // Model transport attachment completing through the real store action.
    const timer = setTimeout(() => {
      useAppStore.getState().updateTabPtyId(tabId, ptyIdFor(tabId))
    }, 1_100)
    return () => clearTimeout(timer)
  }, [tabId])
  return null
}

function ParkingHost(): React.JSX.Element {
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  const pendingStartupByTabId = useAppStore((state) => state.pendingStartupByTabId)
  const terminalTabs = tabsByWorktree[WORKTREE_ID]
  const parkedWorktrees = selectColdParkedTerminalWorktrees({
    worktrees: [
      {
        worktreeId: WORKTREE_ID,
        terminalTabs,
        hiddenSinceMs: START_MS - 6 * 60_000,
        isVisible: false,
        shouldMeasureHiddenWorktree: false,
        hasActivityTerminalPortal: false
      },
      {
        worktreeId: 'retained-peer',
        terminalTabs: [],
        hiddenSinceMs: START_MS - 5 * 60_000,
        isVisible: false,
        shouldMeasureHiddenWorktree: false,
        hasActivityTerminalPortal: false
      }
    ],
    pendingStartupByTabId,
    parkingEnabled: true,
    restorePolicy: { sshParkingEnabled: true },
    nowMs: START_MS
  })
  parkedTabIds = useTerminalTabColdParking({
    worktreeId: WORKTREE_ID,
    terminalTabs,
    assignments: ASSIGNMENTS,
    isWorktreeActive: false,
    activeTerminalTabId: null,
    coldParkTerminalPanes:
      parkedWorktrees.has(WORKTREE_ID) &&
      terminalTabs.every((tab) => canWatcherCoverParkedTerminalTab(WORKTREE_ID, tab)),
    shouldMeasureHiddenWorktree: false,
    activityTerminalPortals: PORTALS
  })
  return createElement(
    Fragment,
    null,
    terminalTabs.map((tab) =>
      parkedTabIds.has(tab.id) ? null : createElement(AttachedPane, { key: tab.id, tabId: tab.id })
    )
  )
}

function ownSnapshot(revision: number): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: Date.now(),
    schemaVersion: 1,
    session: exportRemoteWorkspaceSession(buildWorkspaceSessionPayload(useAppStore.getState()), {
      isTargetWorktree: (id) => id === WORKTREE_ID
    })
  }
}

async function applySnapshot(snapshot: RemoteWorkspaceObservedSnapshot): Promise<void> {
  const result = await applyDirectSshRemoteWorkspaceSnapshot({
    store: useAppStore,
    snapshot,
    token: {
      authority,
      catalogRevision: 0,
      repoFingerprint: 'parking-repo',
      authorityRequirement: 'required',
      snapshotRevision: snapshot.revision,
      outcome: 'complete'
    },
    arrival: snapshot.revision,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    waitForWorkspaceSessionReady: async () => true,
    finalizeHydratedTerminals: () => useAppStore.getState().retryDirectSshTargetPanes(authority)
  })
  expect(result).toBe('applied')
}

async function deliverReadAfterOwnReply(own: RemoteWorkspaceSnapshot, read = own): Promise<void> {
  request.mockResolvedValue(read)
  let releaseRead: ((snapshot: RemoteWorkspaceSnapshot) => void) | undefined
  request.mockImplementationOnce(
    () =>
      new Promise<RemoteWorkspaceSnapshot>((resolve) => {
        releaseRead = resolve
      })
  )
  const applies: Promise<void>[] = []
  const errors: unknown[] = []
  const resync = resyncStaleRemoteWorkspace(
    TARGET,
    (snapshot) => {
      applies.push(applySnapshot(snapshot))
    },
    (error) => errors.push(error)
  )
  expect(request).toHaveBeenLastCalledWith('workspace.get', { namespace: expect.any(String) })
  rememberLocallyPatchedRemoteWorkspaceSnapshot(TARGET_ID, own)
  await act(async () => {
    releaseRead?.(read)
    await resync
    await Promise.all(applies)
  })
  expect(errors).toEqual([])
}

describe('direct SSH snapshot delivery and parking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START_MS)
    mounts.clear()
    request.mockReset()
    clearRemoteWorkspaceSnapshotCache()
    _resetRemoteWorkspaceStaleResyncForTests()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: {
          onData: () => () => {},
          onReplay: () => () => {},
          onExit: () => () => {}
        }
      }
    })
    disposeAllParkedTerminalWatchers()
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      repos: [
        {
          id: 'repo-ssh',
          path: '/work',
          displayName: 'SSH',
          badgeColor: 'blue',
          addedAt: 0,
          connectionId: TARGET_ID
        }
      ],
      worktreesByRepo: {
        'repo-ssh': [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo-ssh',
            path: '/work/ssh-parking',
            hostId: `ssh:${TARGET_ID}`
          })
        ]
      },
      sshConnectionStates: new Map([
        [TARGET_ID, { ...authority, status: 'connected', error: null, reconnectAttempt: 0 }]
      ]),
      tabsByWorktree: { [WORKTREE_ID]: TABS },
      ptyIdsByTabId: Object.fromEntries(TABS.map((tab) => [tab.id, [ptyIdFor(tab.id)]])),
      lastKnownRelayPtyIdByTabId: Object.fromEntries(TABS.map((tab) => [tab.id, ptyIdFor(tab.id)])),
      terminalLayoutsByTabId: Object.fromEntries(
        TABS.map((tab) => [tab.id, singlePaneLayoutSnapshot(LEAF_ID, ptyIdFor(tab.id))])
      )
    })
  })

  afterEach(() => {
    cleanup()
    disposeAllParkedTerminalWatchers()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.useRealTimers()
  })

  it('keeps panes parked through pending-read own echoes while still applying a peer edit', async () => {
    render(createElement(ParkingHost))
    expect(parkedTabIds).toEqual(new Set(TABS.map((tab) => tab.id)))
    expect(mounts.size).toBe(0)
    rememberRemoteWorkspaceSnapshot(TARGET_ID, ownSnapshot(0))

    // Visibility, ordering, measurement and saved PTY coverage stay unchanged throughout.

    for (let revision = 1; revision <= 4; revision += 1) {
      act(() => {
        vi.advanceTimersByTime(2_000)
        useAppStore.getState().updateTabTitle('tab-a', `Local title ${revision}`)
      })
      await deliverReadAfterOwnReply(ownSnapshot(revision))
      expect(parkedTabIds).toEqual(new Set(TABS.map((tab) => tab.id)))
      expect(mounts.size).toBe(0)
    }

    const own = ownSnapshot(5)
    const peer = structuredClone(own)
    peer.revision = 6
    for (const tabs of Object.values(peer.session.tabsByWorktreePath)) {
      for (const tab of tabs) {
        if (tab.id === 'tab-a') {
          tab.title = 'Peer title'
        }
      }
    }
    await deliverReadAfterOwnReply(own, peer)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID][0].title).toBe('Peer title')
    expect([...mounts.values()]).toEqual([1, 1])
    expect(parkedTabIds.size).toBe(0)
    act(() => vi.advanceTimersByTime(1_100))
    expect(parkedTabIds).toEqual(new Set(TABS.map((tab) => tab.id)))
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID].map((tab) => tab.ptyId)).toEqual(
      TABS.map((tab) => ptyIdFor(tab.id))
    )
  })
})
