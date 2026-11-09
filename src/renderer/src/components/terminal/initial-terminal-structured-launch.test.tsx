// @vitest-environment happy-dom
import type * as ParkedWatcherRegistryModule from '../terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  claimEmptyWorkspaceDefaultSurface,
  releaseEmptyWorkspaceDefaultSurface
} from '@/lib/workspace/activation/initial-surface/empty-workspace-default-surface-claims'

const mocks = vi.hoisted(() => {
  const storeTabsByWorktree: Record<string, unknown[]> = {}
  const storeClosedRecords: Record<string, { worktreeId: string; closedAt: number }> = {}
  const storePendingCreations: Record<string, PendingWorktreeCreation> = {}
  return {
    gate: vi.fn(),
    resume: vi.fn(),
    authority: 'none',
    launchStatus: vi.fn((_worktreeId: string, _provider: string): string => 'idle'),
    createTab: vi.fn(),
    storeTabsByWorktree,
    storeClosedRecords,
    storePendingCreations
  }
})
vi.mock('@/store', () => {
  const getState = () => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: mocks.storeTabsByWorktree,
    closedTerminalTabTombstonesByTabId: mocks.storeClosedRecords,
    pendingWorktreeCreations: mocks.storePendingCreations
  })
  return {
    useAppStore: Object.assign(
      (selector: (state: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    )
  }
})
vi.mock('@/lib/workspace/activation/worktree-agent-activation-gate', () => ({
  gateWorktreeAgentActivation: mocks.gate
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-status', () => ({
  hasStructuredAgentLaunchInWorktree: (worktreeId: string) =>
    ['claude', 'codex', 'grok'].some((agent) => mocks.launchStatus(worktreeId, agent) !== 'idle')
}))
vi.mock('@/lib/agent-session/resume/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: mocks.resume
}))
vi.mock('@/lib/workspace/ownership/workspace-terminal-host-authority', () => ({
  createWorkspaceTerminalHostAuthoritySelector: () => () => mocks.authority
}))
vi.mock('../terminal-pane/parking/output-watchers/terminal-parked-tab-watchers', () => ({
  syncParkedTerminalTabWatchersForWorkspaces: vi.fn()
}))

vi.mock(
  '../terminal-pane/parking/output-watchers/terminal-parked-watcher-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ParkedWatcherRegistryModule>()),
    pruneParkedTerminalWatchers: vi.fn(),
    terminalWatcherLiveWorkspaceIds: () => new Set(),
    disposeAllParkedTerminalWatchers: vi.fn()
  })
)

const PENDING_INTENT = { callerProvidesSurface: false, seedUserDefaultSurface: true }

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
  mocks.authority = 'none'
  mocks.storeTabsByWorktree = {}
  mocks.storeClosedRecords = {}
  mocks.storePendingCreations = {}
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
    startupTerminalTabHold: null,
    terminalParkingEnabled: false,
    terminalProviderSnapshotCapabilityRevision: 0,
    terminalSshParkingEnabled: false,
    terminalTitleSnapshotAuthorityEnabled: false
  })
  return null
}

describe('passive terminal seeding during native chat creation', () => {
  it('waits for worktree creation before checking whether a fallback shell is needed', async () => {
    mocks.storePendingCreations['creation-1'] = {
      creationId: 'creation-1',
      worktreeId: 'wt-1',
      phase: 'creating',
      status: 'creating',
      startedAt: 1,
      indeterminate: false,
      loaderVisible: true,
      request: {
        repoId: 'repo-1',
        name: 'workspace',
        setupDecision: 'inherit',
        agent: 'codex',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }
    }
    mocks.gate.mockResolvedValue('empty')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))
    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.createTab).not.toHaveBeenCalled()

    mocks.storePendingCreations = {}
    await act(async () => root?.render(<Watcher />))
    expect(mocks.createTab).toHaveBeenCalledOnce()
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
    // closeTab empties the row and records the close in the same store write.
    mocks.storeTabsByWorktree = { 'wt-1': [] }
    mocks.storeClosedRecords = { 'closed-tab': { worktreeId: 'wt-1', closedAt: Date.now() } }
    await finishGate('empty')
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  // Leaving cancels reseed; returning must still seed the workspace.
  it('seeds on return to a workspace left while a reseed awaited agent detection', async () => {
    mocks.gate.mockResolvedValue('empty')
    claimEmptyWorkspaceDefaultSurface('wt-1', PENDING_INTENT)
    root = createRoot(document.createElement('div'))
    try {
      await act(async () => root?.render(<Watcher />))
      expect(mocks.createTab).not.toHaveBeenCalled()
    } finally {
      releaseEmptyWorkspaceDefaultSurface('wt-1')
    }

    await act(async () => root?.render(<Watcher worktreeId="wt-2" />))
    await act(async () => root?.render(<Watcher />))
    expect(mocks.createTab).toHaveBeenCalledTimes(1)
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
