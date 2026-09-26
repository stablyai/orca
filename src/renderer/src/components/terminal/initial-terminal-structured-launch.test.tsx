// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import type * as ActivationGateModule from '@/lib/worktree-agent-activation-gate'

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  resume: vi.fn(),
  authority: 'none',
  launchStatus: vi.fn((_worktreeId: string, _provider: string): string => 'idle'),
  createTab: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => mocks.authority, {
    getState: () => ({ activeWorktreeId: 'wt-1' })
  })
}))
vi.mock('@/lib/worktree-agent-activation-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivationGateModule>()),
  gateWorktreeAgentActivation: mocks.gate
}))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  getStructuredAgentLaunchStatus: mocks.launchStatus
}))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: mocks.resume
}))
vi.mock('@/lib/workspace-terminal-host-authority', () => ({
  createWorkspaceTerminalHostAuthoritySelector: () => () => 'none'
}))
vi.mock('../terminal-pane/terminal-parked-tab-watchers', () => ({
  pruneParkedTerminalWatchers: vi.fn(),
  terminalWatcherLiveWorkspaceIds: () => new Set(),
  syncParkedTerminalTabWatchersForWorkspaces: vi.fn(),
  disposeAllParkedTerminalWatchers: vi.fn()
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
  mocks.authority = 'none'
})

function Watcher({ restored = true, hydrated = false, worktreeId = 'wt-1' } = {}): null {
  useTerminalWatcherEffects({
    activeWorktreeId: worktreeId,
    workspaceSessionReady: true,
    terminalStartupRestorationReady: restored,
    hydrationSucceeded: hydrated,
    workspaceSurfaceIds: [],
    tabsByWorktree: {},
    createTab: mocks.createTab,
    reconcileWorktreeTabModel: () => ({
      renderableTabCount: 0,
      activeRenderableTabId: null
    }),
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeView: 'terminal',
    activityTerminalPortals: [],
    anyMountedWorktreeHasLayout: false,
    backgroundMountRevision: 0,
    effectiveParkedTerminalWorktreeIds: new Set(),
    evictionExemptTerminalTabIds: new Set(),
    getEffectiveLayoutForWorktree: () => undefined,
    groupsByWorktree: {},
    measurableBackgroundWorktreeIdsRef: { current: new Set() },
    mountedWorktreeIdsRef: { current: new Set() },
    pairedRuntimeParkingEnvironmentIds: new Set(),
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: worktreeId,
    terminalParkingEnabled: false,
    terminalProviderSnapshotCapabilityRevision: 0,
    terminalSshParkingEnabled: false,
    terminalTitleSnapshotAuthorityEnabled: false
  })
  return null
}

describe('passive terminal seeding during native chat creation', () => {
  it.each([
    ['claude', 'pending', 0],
    ['codex', 'pending', 0],
    ['claude', 'unknown', 0],
    ['codex', 'unknown', 0],
    ['claude', 'idle', 1]
  ] as const)('handles %s launch status %s', async (agent, status, expectedTabs) => {
    let finishGate!: (outcome: 'empty') => void
    mocks.gate.mockReturnValue(
      new Promise((resolve) => {
        finishGate = resolve
      })
    )
    mocks.launchStatus.mockReturnValue('idle')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))

    // A create starts after the inventory probe but before its empty result returns.
    mocks.launchStatus.mockImplementation((_worktreeId, provider) =>
      provider === agent ? status : 'idle'
    )
    await act(async () => finishGate('empty'))

    expect(mocks.createTab).toHaveBeenCalledTimes(expectedTabs)
  })
})

describe('startup agent recovery host inventory', () => {
  it('keeps recovery available until the execution host answers', async () => {
    mocks.authority = 'unverifiable'
    mocks.gate.mockResolvedValue('adopted')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher hydrated />))
    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    mocks.authority = 'live'
    await act(async () => root?.render(<Watcher hydrated />))
    expect(mocks.gate).toHaveBeenCalledTimes(1)
    await act(async () => root?.render(<Watcher hydrated />))
    expect(mocks.gate).toHaveBeenCalledTimes(1)
  })

  it('waits for terminal restoration, then uses the activation gate', async () => {
    mocks.authority = 'live'
    mocks.gate.mockResolvedValue('adopted')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher hydrated restored={false} />))
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
    await act(async () => root?.render(<Watcher hydrated />))
    expect(mocks.gate).toHaveBeenCalledWith('wt-1')
    expect(mocks.resume).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'rejected'])(
    'retries a %s startup after leaving and returning',
    async (outcome) => {
      mocks.authority = 'live'
      if (outcome === 'rejected') {
        mocks.gate.mockRejectedValue(new Error('host unavailable'))
      } else {
        mocks.gate.mockResolvedValue('blocked')
      }
      root = createRoot(document.createElement('div'))
      await act(async () => root?.render(<Watcher hydrated />))
      expect(mocks.gate).toHaveBeenCalledTimes(1)
      await act(async () => root?.render(<Watcher hydrated worktreeId="wt-2" />))
      mocks.gate.mockResolvedValue('adopted')
      await act(async () => root?.render(<Watcher hydrated />))
      expect(mocks.gate.mock.calls.map(([id]) => id)).toEqual(['wt-1', 'wt-2', 'wt-1'])
      expect(mocks.resume).not.toHaveBeenCalled()
    }
  )
})
