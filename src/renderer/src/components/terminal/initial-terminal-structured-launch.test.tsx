// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'

const mocks = vi.hoisted(() => {
  const storeTabsByWorktree: Record<string, unknown[]> = {}
  return {
    gate: vi.fn(),
    resume: vi.fn(),
    authority: 'none',
    launchStatus: vi.fn((_worktreeId: string, _provider: string): string => 'idle'),
    createTab: vi.fn(),
    storeTabsByWorktree
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => mocks.authority, {
    getState: () => ({ activeWorktreeId: 'wt-1', tabsByWorktree: mocks.storeTabsByWorktree })
  })
}))
vi.mock('@/lib/worktree-agent-activation-gate', () => ({
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
  mocks.storeTabsByWorktree = {}
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

function deferredGate(): (outcome: 'empty' | 'blocked') => Promise<void> {
  let finishGate!: (outcome: 'empty' | 'blocked') => void
  // One shared promise, as the gate's in-flight dedupe hands every rerun.
  mocks.gate.mockReturnValue(
    new Promise((resolve) => {
      finishGate = resolve
    })
  )
  return async (outcome) => act(async () => finishGate(outcome))
}

describe('passive terminal seeding retries until a decision applies', () => {
  it('seeds once after a StrictMode double run', async () => {
    const finishGate = deferredGate()
    const renderStrict = () =>
      root?.render(
        <StrictMode>
          <Watcher />
        </StrictMode>
      )
    root = createRoot(document.createElement('div'))
    await act(async () => renderStrict())
    await finishGate('empty')
    expect(mocks.createTab).toHaveBeenCalledTimes(1)

    // The applied decision is final: a later run neither re-checks nor seeds again.
    await act(async () => renderStrict())
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.gate).toHaveBeenCalledTimes(2)
  })

  it('seeds once when an input changes mid-check', async () => {
    const finishGate = deferredGate()
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))
    // Each render passes a fresh reconcile callback, so this rerun cancels the first check.
    await act(async () => root?.render(<Watcher />))
    await finishGate('empty')
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.gate).toHaveBeenCalledTimes(2)
  })

  it('seeds once across two empty checks separated by leaving the workspace', async () => {
    const resolvers: ((outcome: 'empty') => void)[] = []
    mocks.gate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))
    await act(async () => root?.render(<Watcher worktreeId="wt-2" />))
    await act(async () => root?.render(<Watcher />))
    await act(async () => resolvers.forEach((resolve) => resolve('empty')))
    await act(async () => root?.render(<Watcher />))

    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.gate).toHaveBeenCalledTimes(3)
  })

  it('does not seed a workspace whose last terminal closed during the check', async () => {
    const finishGate = deferredGate()
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))
    mocks.storeTabsByWorktree = { 'wt-1': [] }
    await finishGate('empty')
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it('seeds after leaving and returning to a blocked workspace', async () => {
    mocks.gate.mockResolvedValue('blocked')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))
    expect(mocks.createTab).not.toHaveBeenCalled()

    await act(async () => root?.render(<Watcher worktreeId="wt-2" />))
    mocks.gate.mockResolvedValue('empty')
    await act(async () => root?.render(<Watcher />))
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
    expect(mocks.createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      pendingActivationSpawn: true
    })
    expect(mocks.gate.mock.calls.map(([id]) => id)).toEqual(['wt-1', 'wt-2', 'wt-1'])
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
