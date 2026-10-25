// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acknowledgeAgents: vi.fn(),
  setActiveWorktree: vi.fn(),
  subscribeStore: vi.fn((_listener: (state: unknown, previousState: unknown) => void) => vi.fn()),
  onRevealAgent: vi.fn(),
  onAckAgent: vi.fn(),
  onPopoutOpenChanged: vi.fn(),
  onSnapshotRequested: vi.fn(),
  getPopoutOpen: vi.fn(async () => false),
  publishSnapshot: vi.fn(async (_snapshot: DashboardSnapshot) => undefined),
  buildDashboardSnapshot: vi.fn((_state: unknown, now: number): DashboardSnapshot => ({
    generatedAt: now,
    cards: []
  })),
  offRevealAgent: vi.fn(),
  offAckAgent: vi.fn(),
  offPopoutOpenChanged: vi.fn(),
  offSnapshotRequested: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  activateAndRevealWorkspace: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...makeSnapshotWatchState(),
      acknowledgeAgents: mocks.acknowledgeAgents,
      setActiveWorktree: mocks.setActiveWorktree
    }),
    subscribe: mocks.subscribeStore
  }
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))

vi.mock('./build-dashboard-snapshot', () => ({
  buildDashboardSnapshot: mocks.buildDashboardSnapshot
}))

import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import {
  dashboardSnapshotInputsChanged,
  repoIconsUnchanged,
  useDashboardPopoutBridge
} from './useDashboardPopoutBridge'

type DashboardSnapshotWatchState = Parameters<typeof dashboardSnapshotInputsChanged>[0]

function makeSnapshotWatchState(): DashboardSnapshotWatchState {
  return {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    agentStatusEpoch: 0,
    // Seed distinct real identities so host-profile comparisons cannot pass against undefined.
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    paneForegroundAgentByPaneKey: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    sshTargetLabels: new Map(),
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: false,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    activeRepoId: null,
    projects: [],
    removedRuntimeEnvironmentIds: new Set()
  }
}

function Harness({ enabled }: { enabled: boolean }): null {
  useDashboardPopoutBridge(enabled)
  return null
}

function installDashboardApi(): void {
  mocks.onRevealAgent.mockReturnValue(mocks.offRevealAgent)
  mocks.onAckAgent.mockReturnValue(mocks.offAckAgent)
  mocks.onPopoutOpenChanged.mockReturnValue(mocks.offPopoutOpenChanged)
  mocks.onSnapshotRequested.mockReturnValue(mocks.offSnapshotRequested)
  ;(window as unknown as { api: unknown }).api = {
    dashboard: {
      onRevealAgent: mocks.onRevealAgent,
      onAckAgent: mocks.onAckAgent,
      onPopoutOpenChanged: mocks.onPopoutOpenChanged,
      onSnapshotRequested: mocks.onSnapshotRequested,
      getPopoutOpen: mocks.getPopoutOpen,
      publishSnapshot: mocks.publishSnapshot
    }
  }
}

describe('useDashboardPopoutBridge', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    installDashboardApi()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('does not register dashboard or store subscriptions while disabled', async () => {
    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.onRevealAgent).not.toHaveBeenCalled()
    expect(mocks.onAckAgent).not.toHaveBeenCalled()
    expect(mocks.onPopoutOpenChanged).not.toHaveBeenCalled()
    expect(mocks.onSnapshotRequested).not.toHaveBeenCalled()
    expect(mocks.getPopoutOpen).not.toHaveBeenCalled()
    expect(mocks.subscribeStore).not.toHaveBeenCalled()
  })

  // Closed pop-outs must not subscribe and rebuild cross-worktree snapshots on store writes.
  it('subscribes to the store only while the pop-out is open', async () => {
    await act(async () => root.render(<Harness enabled />))

    expect(mocks.onPopoutOpenChanged).toHaveBeenCalledTimes(1)
    expect(mocks.subscribeStore).not.toHaveBeenCalled()
    expect(mocks.buildDashboardSnapshot).not.toHaveBeenCalled()

    await act(async () => mocks.onPopoutOpenChanged.mock.calls[0][0](true))

    expect(mocks.subscribeStore).toHaveBeenCalledTimes(1)
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledTimes(1)
    const unsubscribe = mocks.subscribeStore.mock.results[0]?.value as () => void
    const notifyStore = mocks.subscribeStore.mock.calls[0][0]

    await act(async () => mocks.onPopoutOpenChanged.mock.calls[0][0](false))

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const previousState = makeSnapshotWatchState()
    await act(async () => notifyStore({ ...previousState, agentStatusEpoch: 1 }, previousState))
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledTimes(1)
  })

  it('reveals the agent on its exact execution host through the full activation', async () => {
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: null })
    await act(async () => root.render(<Harness enabled />))

    await act(async () =>
      mocks.onRevealAgent.mock.calls[0][0]({
        repoId: 'repo-1',
        worktreeId: 'shared-worktree',
        executionHostId: 'runtime:env-1',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    )

    // Shared activation revives parked workspaces and their terminal view before pane focus.
    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('shared-worktree', {
      executionHostId: 'runtime:env-1'
    })
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', 'leaf-1', {
      flashFocusedPane: true
    })
  })

  it('activates a parked SSH workspace before reaching for its pane', async () => {
    mocks.activateAndRevealWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    await act(async () => root.render(<Harness enabled />))

    await act(async () =>
      mocks.onRevealAgent.mock.calls[0][0]({
        repoId: 'repo-1',
        worktreeId: 'remote-worktree',
        executionHostId: 'ssh:devbox',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    )

    expect(mocks.activateAndRevealWorkspace).toHaveBeenCalledWith('remote-worktree', {
      executionHostId: 'ssh:devbox'
    })
    expect(mocks.activateAndRevealWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTabAndFocusPane.mock.invocationCallOrder[0] as number
    )
  })

  it('skips pane focus when the revealed workspace is gone', async () => {
    mocks.activateAndRevealWorkspace.mockReturnValue(false)
    await act(async () => root.render(<Harness enabled />))

    await act(async () =>
      mocks.onRevealAgent.mock.calls[0][0]({
        repoId: 'repo-1',
        worktreeId: 'deleted-worktree',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      })
    )

    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('ignores unrelated store writes while retaining every snapshot input', () => {
    const previousState = makeSnapshotWatchState()
    expect(dashboardSnapshotInputsChanged({ ...previousState }, previousState)).toBe(false)

    const referenceInputs = [
      'repos',
      'worktreesByRepo',
      'tabsByWorktree',
      'unifiedTabsByWorktree',
      'retainedAgentsByPaneKey',
      'migrationUnsupportedByPtyId',
      'runtimeAgentOrchestrationByPaneKey',
      'terminalLayoutsByTabId',
      'ptyIdsByTabId',
      'runtimePaneTitlesByTabId',
      'acknowledgedAgentsByPaneKey',
      'hostedReviewCache',
      'prCache',
      'settings',
      'workspaceStatuses'
    ] as const
    for (const key of referenceInputs) {
      expect(
        dashboardSnapshotInputsChanged({ ...previousState, [key]: {} }, previousState),
        key
      ).toBe(true)
    }
    expect(
      dashboardSnapshotInputsChanged(
        { ...previousState, agentStatusByPaneKey: { ...previousState.agentStatusByPaneKey } },
        previousState
      )
    ).toBe(false)
    expect(
      dashboardSnapshotInputsChanged({ ...previousState, agentStatusEpoch: 1 }, previousState)
    ).toBe(false)
    expect(
      dashboardSnapshotInputsChanged(
        { ...previousState, sshTargetLabels: new Map([['target-1', 'Builder']]) },
        previousState
      )
    ).toBe(true)

    // Host-profile inputs must republish independently; otherwise idle boards keep encoding for the PTY’s former host.
    const profileInputs: Partial<DashboardSnapshotWatchState>[] = [
      { sshConnectionStates: new Map() },
      { sshStateByEnvironment: new Map() },
      { runtimeStatusByEnvironmentId: new Map() },
      { paneForegroundAgentByPaneKey: {} },
      { detectedWorktreesByRepo: {} },
      // A folder workspace is not a git worktree; its host resolves through these.
      { folderWorkspaces: [] },
      { projectGroups: [] },
      { restoredRuntimeHostIdByWorkspaceSessionKey: {} },
      { runtimeEnvironments: [] },
      { runtimeEnvironmentCatalogHydrated: true },
      { removedRuntimeEnvironmentIds: new Set() }
    ]
    const republished = profileInputs
      .filter((next) =>
        dashboardSnapshotInputsChanged({ ...previousState, ...next }, previousState)
      )
      .map((next) => Object.keys(next)[0])
    expect(republished).toEqual(profileInputs.map((next) => Object.keys(next)[0]))
  })

  it('republishes when the unified agent-session tab projection changes', () => {
    const previousState = makeSnapshotWatchState()
    expect(
      dashboardSnapshotInputsChanged(
        {
          ...previousState,
          unifiedTabsByWorktree: { 'worktree-1': [] }
        },
        previousState
      )
    ).toBe(true)
  })

  it('releases every dashboard listener when the experiment is disabled', async () => {
    await act(async () => root.render(<Harness enabled />))

    expect(mocks.onRevealAgent).toHaveBeenCalledTimes(1)
    expect(mocks.onAckAgent).toHaveBeenCalledTimes(1)
    expect(mocks.onPopoutOpenChanged).toHaveBeenCalledTimes(1)
    expect(mocks.onSnapshotRequested).toHaveBeenCalledTimes(1)
    expect(mocks.getPopoutOpen).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.offRevealAgent).toHaveBeenCalledTimes(1)
    expect(mocks.offAckAgent).toHaveBeenCalledTimes(1)
    expect(mocks.offPopoutOpenChanged).toHaveBeenCalledTimes(1)
    expect(mocks.offSnapshotRequested).toHaveBeenCalledTimes(1)
  })
})

describe('repoIconsUnchanged', () => {
  const icon: RepoIcon = { type: 'image', src: 'data:image/png;base64,AAAA', source: 'upload' }

  it('treats a first publish as changed so the pop-out always gets a map', () => {
    expect(repoIconsUnchanged({ r1: icon }, null)).toBe(false)
  })

  it('matches on reference, not deep value, so an unchanged repo skips the resend', () => {
    expect(repoIconsUnchanged({ r1: icon }, { r1: icon })).toBe(true)
    // Rebuilt immutable icon objects may represent new content; reference replacement must trigger publication.
    expect(repoIconsUnchanged({ r1: { ...icon } }, { r1: icon })).toBe(false)
  })

  it('detects an added, removed, or swapped repo', () => {
    expect(repoIconsUnchanged({ r1: icon, r2: icon }, { r1: icon })).toBe(false)
    expect(repoIconsUnchanged({ r1: icon }, { r1: icon, r2: icon })).toBe(false)
    // Same size, different keys — a plain length check would miss this.
    expect(repoIconsUnchanged({ r2: icon }, { r1: icon })).toBe(false)
  })

  it('handles repos with no icon', () => {
    expect(repoIconsUnchanged({ r1: null }, { r1: null })).toBe(true)
    expect(repoIconsUnchanged({ r1: icon }, { r1: null })).toBe(false)
    expect(repoIconsUnchanged({}, {})).toBe(true)
  })
})

describe('useDashboardPopoutBridge repo icon publishing', () => {
  const icons: Record<string, RepoIcon> = {
    r1: { type: 'image', src: 'data:image/png;base64,AAAA', source: 'upload' }
  }
  // Cross the throttle boundary so changes publish immediately rather than wait on a trailing timer.
  const PAST_THROTTLE_MS = 1_000
  const WITHIN_THROTTLE_MS = 50
  let root: Root
  let now = 0
  let nowSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    now = 10_000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    mocks.buildDashboardSnapshot.mockImplementation((_state, at) => ({
      generatedAt: at,
      cards: [],
      repoIconsByRepoId: icons
    }))
    installDashboardApi()
    root = createRoot(document.createElement('div'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => root.unmount())
    nowSpy.mockRestore()
  })

  const lastPublished = (): DashboardSnapshot => mocks.publishSnapshot.mock.calls.at(-1)![0]
  const setPopoutOpen = (open: boolean): void => {
    act(() => mocks.onPopoutOpenChanged.mock.calls[0][0](open))
  }
  const notifySnapshotInputsChanged = (): void => {
    const previousState = makeSnapshotWatchState()
    act(() =>
      mocks.subscribeStore.mock.calls[0][0](
        { ...previousState, acknowledgedAgentsByPaneKey: { pane: 1 } },
        previousState
      )
    )
  }
  const notifyUnrelatedStoreWrite = (): void => {
    const previousState = makeSnapshotWatchState()
    act(() => mocks.subscribeStore.mock.calls[0][0]({ ...previousState }, previousState))
  }
  const notifyStatusChurn = (): void => {
    const previousState = makeSnapshotWatchState()
    act(() =>
      mocks.subscribeStore.mock.calls[0][0](
        {
          ...previousState,
          agentStatusByPaneKey: { ...previousState.agentStatusByPaneKey },
          agentStatusEpoch: previousState.agentStatusEpoch + 1
        },
        previousState
      )
    )
  }
  const mountAndOpen = async (): Promise<void> => {
    await act(async () => root.render(<Harness enabled />))
    setPopoutOpen(true)
  }

  it('sends the icon map on open, then omits it while it is unchanged', async () => {
    await mountAndOpen()
    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(1)
    expect(lastPublished().repoIconsByRepoId).toBe(icons)

    now += PAST_THROTTLE_MS
    notifySnapshotInputsChanged()

    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(2)
    expect(lastPublished()).not.toHaveProperty('repoIconsByRepoId')
    expect(lastPublished().generatedAt).toBe(now)
  })

  it('skips the republish when a store write touches no snapshot input', async () => {
    await mountAndOpen()
    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(1)

    // Assert beyond the throttle so an ungated publish cannot hide on its trailing timer.
    now += PAST_THROTTLE_MS
    notifyUnrelatedStoreWrite()

    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does no snapshot work during live status churn', async () => {
    await mountAndOpen()
    mocks.buildDashboardSnapshot.mockClear()
    mocks.publishSnapshot.mockClear()

    for (let index = 0; index < 100; index += 1) {
      notifyStatusChurn()
    }

    expect(mocks.buildDashboardSnapshot).not.toHaveBeenCalled()
    expect(mocks.publishSnapshot).not.toHaveBeenCalled()
  })

  // Bursts publish on the trailing timer; that path must omit unchanged icons too.
  it('omits the icon map on the throttled trailing republish', async () => {
    await mountAndOpen()
    // Date.now stays spied — only the throttle's timer is faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    now += WITHIN_THROTTLE_MS
    notifySnapshotInputsChanged()
    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(1)

    now += PAST_THROTTLE_MS
    act(() => {
      vi.advanceTimersByTime(PAST_THROTTLE_MS)
    })

    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(2)
    expect(lastPublished()).not.toHaveProperty('repoIconsByRepoId')
  })

  it('resends the icon map when the pop-out asks for a fresh snapshot', async () => {
    await mountAndOpen()
    now += PAST_THROTTLE_MS
    notifySnapshotInputsChanged()
    expect(lastPublished()).not.toHaveProperty('repoIconsByRepoId')

    // A remounted pop-out has no retained map, so its request must be answered in full.
    now += PAST_THROTTLE_MS
    act(() => mocks.onSnapshotRequested.mock.calls[0][0]())

    expect(lastPublished().repoIconsByRepoId).toBe(icons)
  })

  it('resends the icon map when the pop-out is reopened', async () => {
    await mountAndOpen()
    setPopoutOpen(false)
    now += PAST_THROTTLE_MS
    setPopoutOpen(true)

    expect(mocks.publishSnapshot).toHaveBeenCalledTimes(2)
    expect(lastPublished().repoIconsByRepoId).toBe(icons)
  })

  it('resends the icon map when an icon actually changes', async () => {
    await mountAndOpen()
    const nextIcons: Record<string, RepoIcon> = { r1: { type: 'emoji', emoji: '🦑' } }
    mocks.buildDashboardSnapshot.mockImplementation((_state, at) => ({
      generatedAt: at,
      cards: [],
      repoIconsByRepoId: nextIcons
    }))

    now += PAST_THROTTLE_MS
    notifySnapshotInputsChanged()

    expect(lastPublished().repoIconsByRepoId).toBe(nextIcons)
  })
})
