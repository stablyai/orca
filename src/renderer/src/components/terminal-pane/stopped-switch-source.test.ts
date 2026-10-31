import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createManager, createPane } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { launchWorkspaceId } from '../../../../shared/launch-parity-window-request.test-fixture'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

// A real pane and store: a switch kept this pane's stopped screen for a replace that never came,
// and main's settlement turns it into the ordinary exited state.

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle: () => false }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), message: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))

const load = perClientLoader(async () => ({
  pane: await import('./pty-connection'),
  parked: await import('./terminal-parked-tab-watchers'),
  parkedRegistry: await import('./terminal-parked-watcher-registry'),
  sources: await import('./stopped-switch-sources')
}))

beforeAll(async () => {
  await load('linux')
}, 240_000)

afterEach(async () => {
  await restoreTerminalTestGlobals()
  vi.unstubAllGlobals()
})

const incarnationId = 'source-incarnation'
// The PTY dispatcher subscribes to exits once per module load; later panes share that listener.
let dispatchExit: Parameters<typeof window.api.pty.onExit>[0] | undefined

async function keptStoppedPane() {
  const modules = await load('linux')
  modules.sources.resetStoppedSwitchSourcesForTests()
  await installTerminalTestGlobals()
  Object.assign(window.api.platform, { get: () => ({ platform: 'linux', osRelease: '6' }) })
  const workspace = { kind: 'folder', path: '/home/alice/source' } as const
  const worktreeId = launchWorkspaceId(workspace)
  const store = modules.createStore()
  holder.store = store
  store.setState(launchWorkspaceState(workspace, { ...getDefaultSettings('/home/alice') }))
  const pane = createPane(1)
  const manager = createManager(1, 1)
  const ptyId = `${worktreeId}@@switch-source`
  const tab = store.getState().createTab(worktreeId, undefined, undefined, {
    initialPtyId: ptyId,
    initialLeafId: pane.leafId
  })
  const spawn = vi.fn(async () => ({ id: ptyId, incarnationId, isReattach: true }))
  const onExit = vi.fn<typeof window.api.pty.onExit>((listener) => {
    dispatchExit = listener
    return () => {}
  })
  const noop = (): (() => void) => () => {}
  Object.assign(window.api.pty, {
    spawn,
    onData: noop,
    onExit,
    onReplay: noop,
    onWriteUnavailable: noop,
    onSideEffect: noop,
    resize: vi.fn(),
    claimViewport: vi.fn()
  })
  const automaticClose = vi.fn()
  const died = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real store supplies every state member read by the pane fixture.
  const deps = buildPaneConnectionDeps(() => store.getState() as never, {
    tabId: tab.id,
    worktreeId,
    cwd: workspace.path,
    restoredLeafId: pane.leafId,
    restoredPtyIdByLeafId: { [pane.leafId]: ptyId },
    onPtyExitRef: { current: automaticClose },
    onPaneProcessDied: died,
    consumeSuppressedPtyExit: vi.fn(store.getState().consumeSuppressedPtyExit),
    clearTabPtyId: vi.fn(store.getState().clearTabPtyId),
    updateTabPtyId: vi.fn(store.getState().updateTabPtyId)
  })
  const args = mockPanePtyArgs(pane, manager, deps)
  let binding = modules.pane.connectPanePty(...args)
  await flushAsyncTicks(20)
  const transport = args[2].paneTransportsRef.current.get(pane.id)
  const exit = dispatchExit
  if (!transport || !exit) {
    throw new Error('the pane did not connect')
  }
  const source = { worktreeId, tabId: tab.id, leafId: pane.leafId, ptyId, incarnationId }
  return {
    modules,
    store,
    tab,
    pane,
    args,
    transport,
    automaticClose,
    died,
    spawn,
    source,
    stoppedForReplace: () =>
      exit({ id: ptyId, code: 0, incarnationId, preserveRendererBinding: 'closing' }),
    park: () => {
      modules.parked.captureParkedTerminalPaneCandidates(tab.id, worktreeId, [
        { ptyId, paneId: pane.id, leafId: pane.leafId, drivesTabTitle: true }
      ])
      transport.detach?.({ preserveExitObserver: false })
      binding.dispose()
      args[2].paneTransportsRef.current.clear()
      modules.parked.syncParkedTerminalTabWatchersForWorkspaces(
        new Map([[worktreeId, { tabs: [tab], parkedTabIds: new Set([tab.id]) }]])
      )
    },
    reveal: async () => {
      const afterMarkerGrace = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001)
      try {
        args[2].mountFollowsTerminalPark = true
        binding = modules.pane.connectPanePty(...args)
        await flushAsyncTicks(20)
      } finally {
        afterMarkerGrace.mockRestore()
      }
    },
    dispose: () => {
      binding.dispose()
      modules.parkedRegistry.disposeAllParkedTerminalWatchers()
    }
  }
}

it('shows the kept pane exited at its own code once main settles it, with no close', async () => {
  const kept = await keptStoppedPane()
  try {
    kept.stoppedForReplace()
    await flushAsyncTicks(5)
    expect(kept.died).not.toHaveBeenCalled()
    kept.modules.sources.noteStoppedSwitchSource(kept.source)
    await flushAsyncTicks(5)
    expect(kept.died).toHaveBeenCalledExactlyOnceWith({
      paneId: kept.pane.id,
      exitCode: 0,
      startup: null,
      reason: 'process-failed'
    })
    expect(kept.automaticClose).not.toHaveBeenCalled()
    expect(kept.transport.sendInput('must not run\r', 'driving')).toBe(false)
    expect(kept.store.getState().tabsByWorktree[kept.source.worktreeId]).toHaveLength(1)
    // A later notice for the same pane changes nothing.
    kept.modules.sources.noteStoppedSwitchSource(kept.source)
    await flushAsyncTicks(5)
    expect(kept.died).toHaveBeenCalledOnce()
  } finally {
    kept.dispose()
  }
})

it.each([
  ['another process', { ptyId: 'successor-pty' }],
  ['another incarnation', { incarnationId: 'successor-incarnation' }]
])('ignores a settlement for %s', async (_label, other) => {
  const kept = await keptStoppedPane()
  try {
    kept.stoppedForReplace()
    kept.modules.sources.noteStoppedSwitchSource({ ...kept.source, ...other })
    await flushAsyncTicks(5)
    expect(kept.died).not.toHaveBeenCalled()
  } finally {
    kept.dispose()
  }
})

it.each([
  ['closed the tab in the same pass, so nothing shows', true, false],
  ['missed the tab, so the pane shows exited', false, true]
])(
  'waits for the chat a replace named; the replace %s',
  async (_label, replaceClosesTab, settles) => {
    const kept = await keptStoppedPane()
    try {
      kept.stoppedForReplace()
      kept.modules.sources.noteStoppedSwitchSource({
        ...kept.source,
        replacedBySessionId: 'session-1'
      })
      await flushAsyncTicks(5)
      expect(kept.died).not.toHaveBeenCalled()
      const { worktreeId, tabId } = kept.source
      const state = kept.store.getState()
      const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const chat = {
        ...tabs[0]!,
        id: 'chat-tab',
        entityId: 'session-1',
        contentType: 'agent-session' as const
      }
      // The snapshot pass brings the chat and, when the replace applies, drops the terminal.
      const { [tabId]: _closed, ...layouts } = state.terminalLayoutsByTabId
      kept.store.setState({
        unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: [...tabs, chat] },
        ...(replaceClosesTab ? { terminalLayoutsByTabId: layouts } : {})
      })
      await flushAsyncTicks(5)
      expect(kept.died).toHaveBeenCalledTimes(settles ? 1 : 0)
    } finally {
      kept.dispose()
    }
  }
)

it('settles a pane that was parked when main settled it, once it is shown', async () => {
  const kept = await keptStoppedPane()
  try {
    kept.park()
    kept.stoppedForReplace()
    kept.modules.sources.noteStoppedSwitchSource(kept.source)
    await flushAsyncTicks(5)
    expect(kept.died).not.toHaveBeenCalled()
    await kept.reveal()
    expect(kept.died).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ paneId: kept.pane.id, exitCode: 0 })
    )
    expect(kept.automaticClose).not.toHaveBeenCalled()
  } finally {
    kept.dispose()
  }
})

it('settles a pane parked after its exit when shown, without reattaching the stopped process', async () => {
  const kept = await keptStoppedPane()
  try {
    kept.stoppedForReplace()
    await flushAsyncTicks(5)
    kept.park()
    kept.modules.sources.noteStoppedSwitchSource(kept.source)
    await flushAsyncTicks(5)
    expect(kept.died).not.toHaveBeenCalled()
    kept.spawn.mockClear()
    await kept.reveal()
    expect(kept.spawn).not.toHaveBeenCalled()
    expect(kept.died).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ paneId: kept.pane.id, exitCode: 0 })
    )
    expect(kept.automaticClose).not.toHaveBeenCalled()
  } finally {
    kept.dispose()
  }
})

it('does no settlement work for store writes outside the held pane, however many', async () => {
  const kept = await keptStoppedPane()
  try {
    kept.stoppedForReplace()
    kept.park()
    kept.modules.sources.noteStoppedSwitchSource({
      ...kept.source,
      replacedBySessionId: 'session-1'
    })
    await flushAsyncTicks(5)
    const { getStoppedSwitchSourceReconcileCountForTests: reconciles } = kept.modules.sources
    const unrelatedWrites = async (count: number): Promise<number> => {
      const before = reconciles()
      for (let i = 0; i < count; i += 1) {
        const state = kept.store.getState()
        kept.store.setState({
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            [`other-tab-${i}`]: state.terminalLayoutsByTabId[kept.tab.id]!
          },
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            'other-worktree': [
              ...(state.unifiedTabsByWorktree['other-worktree'] ?? []),
              { ...state.unifiedTabsByWorktree[kept.source.worktreeId]![0]!, id: `other-${i}` }
            ]
          }
        })
        await flushAsyncTicks(1)
      }
      return reconciles() - before
    }
    expect(await unrelatedWrites(20)).toBe(0)
    expect(await unrelatedWrites(200)).toBe(0)
    // A write to the pane's own slice still settles it once it is shown.
    const state = kept.store.getState()
    const tabs = state.unifiedTabsByWorktree[kept.source.worktreeId] ?? []
    kept.store.setState({
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [kept.source.worktreeId]: [
          ...tabs,
          { ...tabs[0]!, id: 'chat-tab', entityId: 'session-1', contentType: 'agent-session' }
        ]
      }
    })
    await flushAsyncTicks(5)
    expect(reconciles()).toBeGreaterThan(0)
    await kept.reveal()
    expect(kept.died).toHaveBeenCalledOnce()
  } finally {
    kept.dispose()
  }
})
