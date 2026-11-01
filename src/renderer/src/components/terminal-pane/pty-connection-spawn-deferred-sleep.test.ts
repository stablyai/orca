import type * as DeferralDrain from '@/lib/pane-spawn-deferral-drain'
import { registerMainOwnedResumeDrainTests } from './pty-connection-main-owned-resume-drain.spec'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  expectWindowStartAskedMain,
  mainLayoutApplyTransport
} from './pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

const { canResumeHostAutomaticRestores, resumeHostAutomaticRestores } = vi.hoisted(() => ({
  canResumeHostAutomaticRestores: vi.fn(async () => true),
  resumeHostAutomaticRestores: vi.fn(async () => {})
}))

vi.mock('@/runtime/resume-host-automatic-restores', () => ({
  canResumeHostAutomaticRestores,
  resumeHostAutomaticRestores
}))

const drain = vi.hoisted(() => ({
  real: false,
  queued: new Map<string, () => Promise<boolean>>()
}))

vi.mock('@/lib/pane-spawn-deferral-drain', async (importOriginal) => {
  const actual = await importOriginal<typeof DeferralDrain>()
  return {
    ...actual,
    queueDeferredRestoreRetry: (
      paneKey: string,
      env: string | null,
      retry: () => Promise<boolean>
    ) =>
      drain.real
        ? actual.queueDeferredRestoreRetry(paneKey, env, retry)
        : drain.queued.set(paneKey, retry),
    cancelDeferredRestoreRetry: (paneKey: string) =>
      drain.real ? actual.cancelDeferredRestoreRetry(paneKey) : drain.queued.delete(paneKey)
  }
})

vi.mock('./terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery: vi.fn(async () => {})
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Pass useCallback through because this suite invokes notification hooks without rendering React.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

const RESUME = { key: 'session_id', id: 'provider-session-1' } as const

function freshSpawns(transport: MockTransport): Record<string, unknown>[] {
  return transport.connect.mock.calls.flatMap((call: unknown[]) => {
    const [options] = call
    return typeof options === 'object' && options !== null && !('sessionId' in options)
      ? [{ ...options }]
      : []
  })
}

// Main’s start hits host capacity after missing reattach; the window owns no spawn, deferral or retry.
async function expectRestoreAskedMainNotDeferred(
  transport: MockTransport,
  paneKey: string
): Promise<void> {
  const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
  // The pane's own launch recipe still registers at mount; what main starts is main's.
  await expectWindowStartAskedMain(transport, paneKey)
  expect(freshSpawns(transport)).toEqual([])
  expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
  expect(drain.queued.has(paneKey)).toBe(false)
}

function deferringTransport(reason = 'live_cap'): MockTransport {
  const transport = createMockTransport(null)
  transport.connect.mockImplementation(
    async (opts: {
      sessionId?: string
      callbacks?: { onSpawnDeferred?: (reason: string) => void }
    }) => {
      // Why: the fixture tab names a PTY that is gone, so only the fresh restore reaches the gate.
      if (!opts.sessionId) {
        opts.callbacks?.onSpawnDeferred?.(reason)
      }
      return undefined
    }
  )
  return transport
}

describe('connectPanePty: a restore the host kept asleep', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    drain.real = false
    drain.queued.clear()
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    mockStoreState.rememberSleepingAgentSession = vi.fn((record: { paneKey: string }) => {
      mockStoreState.sleepingAgentSessionsByPaneKey[record.paneKey] ??= record
    })
    mockStoreState.pendingStartupByTabId = {}
    mockStoreState.automaticAgentResumeClaimsByTabId = {}
    await installTerminalTestGlobals()
    ;(await mainLayoutApplyTransport()).reset()
  })

  afterEach(async () => {
    const { resetDeferredRestoreDrainForTests } = await import('@/lib/pane-spawn-deferral-drain')
    resetDeferredRestoreDrainForTests()
    vi.useRealTimers()
    vi.restoreAllMocks()
    await restoreTerminalTestGlobals()
  })

  async function mainOwnedResumeFixture() {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const record = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: RESUME,
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = record
    mockStoreState.agentStatusByPaneKey = {}
    mockStoreState.tabsByWorktree['wt-1'] = [{ id: 'tab-1', ptyId: null }]
    mockStoreState.terminalLayoutsByTabId ??= {}
    mockStoreState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'leaf', leafId: pane.leafId },
      activeLeafId: pane.leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: {}
    }
    const mainResume = vi.fn(async (_pane: unknown, _automatic?: boolean): Promise<boolean> => {
      throw new Error(
        "Error invoking remote method 'worktrees:resumeSleptPane': Error: terminal_spawn_deferred:live_cap"
      )
    })
    window.api.worktrees = { ...window.api.worktrees, resumeSleptPane: mainResume }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }) => {
      transport.attach({ existingPtyId: 'main-pty', callbacks: callbacks ?? {} })
      return 'main-pty'
    })
    transportFactoryQueue.push(transport)
    const onDeferredCwdSpawnFailed = vi.fn()
    const deps = createDeps({ onDeferredCwdSpawnFailed })
    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0)
    }
    await flushAsyncTicks(30)
    return {
      mainResume,
      transport,
      deps,
      binding,
      paneKey,
      record,
      onDeferredCwdSpawnFailed,
      owner: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: pane.leafId }
    }
  }

  registerMainOwnedResumeDrainTests(
    mainOwnedResumeFixture,
    () => mockStoreState,
    () => {
      drain.real = true
    }
  )

  it('fences late main outcomes and preserves only explicit legacy fallback', async () => {
    const { attachToMainResumedSleepPane } =
      await import('./pty-connection/main-resumed-sleep-pane')
    const { mainResumedSleepPane } = await import('./pty-connection/main-resumed-sleep-pane')
    for (const outcome of [
      'false',
      'generic',
      'automatic-false',
      'sleeping',
      'cancel',
      'dispose',
      'superseded',
      'cancel-refused',
      'dispose-refused',
      'teardown-refused',
      'attach-failed'
    ]) {
      mockStoreState.deleteStateByWorktreeId = {}
      const pane = createPane(1)
      const paneKey = makePaneKey('tab-1', pane.leafId)
      const source = { cancelled: false }
      const startup = {
        command: "claude '--resume' 'provider-session-1'",
        agent: 'claude' as const,
        resumeProviderSession: RESUME,
        resumeOrigin: 'saved' as const,
        launchToken: 'token',
        launchConfig: { agentArgs: '', agentEnv: {} },
        useLiveEntry: false,
        hasSleepingRecord: true,
        resumeSource: source,
        sleepingRecordEntry: {
          paneKey,
          record: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'claude' as const,
            providerSession: RESUME,
            prompt: '',
            state: 'working' as const,
            capturedAt: 1,
            updatedAt: 1,
            origin: 'worktree-sleep' as const
          }
        }
      }
      let land: (value: boolean) => void = () => {}
      let refuse: (error: Error) => void = () => {}
      const pending = new Promise<boolean>((resolve, reject) => {
        land = resolve
        refuse = reject
      })
      const mainResume = vi.fn(() => pending)
      window.api.worktrees = { ...window.api.worktrees, resumeSleptPane: mainResume }
      const fixture = {
        disposed: false,
        transportStreamGeneration: 1,
        tabGeneration: 0,
        cacheKey: paneKey,
        deps: createDeps(),
        transport: { getPtyId: () => null, abandonPreconnectInput: vi.fn() },
        startFreshSpawn: vi.fn(async () => (outcome === 'attach-failed' ? null : 'pty')),
        settlePaneAttachAttempt: vi.fn(),
        enterSpawnDeferredSleep: vi.fn(),
        showSessionRestoredBanner: vi.fn()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies every field the main resume helper and owner selector read.
      const session = fixture as unknown as ConnectPanePtySession
      const owner = { worktreeId: 'wt-1', tabId: 'tab-1', leafId: pane.leafId }
      expect(mainResumedSleepPane(session, startup)).toEqual(owner)
      expect(
        mainResumedSleepPane({ ...session, runtimeEnvironmentId: 'paired' }, startup)
      ).toBeNull()
      expect(mainResumedSleepPane(session, { ...startup, useLiveEntry: true })).toBeNull()
      expect(
        mainResumedSleepPane(session, {
          ...startup,
          sleepingRecordEntry: {
            paneKey,
            record: { ...startup.sleepingRecordEntry.record, origin: 'quit' }
          }
        })
      ).toBeNull()
      expect(
        mainResumedSleepPane(session, {
          ...startup,
          sleepingRecordEntry: {
            paneKey,
            record: { ...startup.sleepingRecordEntry.record, tabId: 'web-terminal-remote' }
          }
        })
      ).toBeNull()
      if (outcome === 'false') {
        const { installSpawnDeferredSleep } = await import('./pty-connection/spawn-deferred-sleep')
        installSpawnDeferredSleep(session)
        const { launchConfig: _launchConfig, ...withoutConfig } = startup
        session.deferredSpawn = { reason: 'live_cap', startupOverride: withoutConfig, options: {} }
        session.spawnColdRestoreAgentResume = vi.fn(async () => null)
        await session.resumeDeferredSpawn()
        expect(session.spawnColdRestoreAgentResume).toHaveBeenCalledWith(withoutConfig, {}, false)
        session.disposeSpawnDeferral()
        session.enterSpawnDeferredSleep = vi.fn()
      }
      const running = attachToMainResumedSleepPane(
        session,
        owner,
        startup,
        {},
        outcome === 'sleeping' || outcome === 'automatic-false'
      )
      if (outcome.startsWith('cancel')) {
        source.cancelled = true
      }
      if (outcome.startsWith('dispose')) {
        fixture.disposed = true
      }
      if (outcome === 'teardown-refused') {
        mockStoreState.deleteStateByWorktreeId = {
          'wt-1': { isDeleting: true }
        }
      }
      if (outcome === 'superseded') {
        fixture.transportStreamGeneration += 1
      }
      // A real Electron rejection is delivered through the same pending operation.
      if (outcome === 'generic' || outcome === 'sleeping' || outcome.endsWith('-refused')) {
        refuse(
          new Error(
            `Error invoking remote method 'worktrees:resumeSleptPane': Error: ${outcome === 'sleeping' ? 'worktree_terminals_sleeping' : outcome.endsWith('-refused') ? 'terminal_spawn_deferred:live_cap' : 'terminal_not_started'}`
          )
        )
      } else {
        land(outcome !== 'false' && outcome !== 'automatic-false')
      }
      await running
      expect(fixture.startFreshSpawn).toHaveBeenCalledTimes(
        ['false', 'generic', 'attach-failed'].includes(outcome) ? 1 : 0
      )
      expect(fixture.showSessionRestoredBanner).not.toHaveBeenCalled()
      expect(fixture.enterSpawnDeferredSleep).not.toHaveBeenCalled()
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    }
  })

  it('keeps the pane sleeping with its resume handle and resumes it when opened', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME,
        launchConfig: { agentArgs: '', agentEnv: {} }
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }

    expect(freshSpawns(transport)).toEqual([
      expect.objectContaining({ resumeSpawnIntent: 'automatic-restore' })
    ])
    expect(getPaneSpawnDeferral(paneKey)?.reason).toBe('live_cap')
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
      paneKey,
      agent: 'claude',
      providerSession: RESUME,
      origin: 'quit',
      restoreOnTabOpenOnly: true
    })
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()

    transport.connect.mockImplementation(async () => 'resumed-pty')
    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(20)

    expect(freshSpawns(transport)).toHaveLength(2)
    expect(freshSpawns(transport)[1]).toMatchObject({ resumeSpawnIntent: 'user-resume' })
    expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
    binding.dispose()
  })

  it("declares a hidden pane's restart and its deferred retry as user resumes, so the live cap cannot defer them", async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport(null)
    // Main takes the replaced PTY with the first request, as the IPC spawn does, then defers it.
    transport.connect.mockImplementation(
      async (opts: {
        claimReplacedPtyId?: () => string | null
        callbacks?: { onSpawnDeferred?: (reason: string) => void }
      }) => {
        opts.claimReplacedPtyId?.()
        opts.callbacks?.onSpawnDeferred?.('pressure')
        return undefined
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      replacesPtyId: 'old-pty',
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      binding.dispose()
      return
    }
    transport.connect.mockImplementation(async () => 'resumed-pty')
    await expect(drain.queued.get(paneKey)?.()).resolves.toBe(true)
    await flushAsyncTicks(20)

    const [first, retry] = freshSpawns(transport)
    expect(first).toMatchObject({ resumeSpawnIntent: 'user-resume' })
    expect(retry).toMatchObject({ resumeSpawnIntent: 'user-resume' })
    binding.dispose()
  })

  it('resumes a hidden pane in the background once the host has room, as an automatic restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }
    const retry = drain.queued.get(paneKey)
    expect(retry).toBeTypeOf('function')

    // Still capped: deferred again, and queued again for a later turn.
    await expect(retry?.()).resolves.toBe(false)
    await flushAsyncTicks(20)
    expect(getPaneSpawnDeferral(paneKey)?.reason).toBe('live_cap')
    expect(drain.queued.has(paneKey)).toBe(true)

    transport.connect.mockImplementation(async () => 'resumed-pty')
    await expect(drain.queued.get(paneKey)?.()).resolves.toBe(true)
    await flushAsyncTicks(20)
    expect(freshSpawns(transport)).toHaveLength(3)
    expect(freshSpawns(transport)[2]).toMatchObject({ resumeSpawnIntent: 'automatic-restore' })
    expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
    binding.dispose()
  })

  it('stops the background retry when the pane is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }
    expect(drain.queued.has(paneKey)).toBe(true)
    binding.dispose()
    expect(drain.queued.has(paneKey)).toBe(false)
  })

  it('does not remount a deferred pane, which would only be deferred again', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
    const { requestTerminalPaneRecovery } = await import('./terminal-pane-recovery')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }

    expect(getPaneSpawnDeferral(paneKey)?.reason).toBe('live_cap')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
    binding.dispose()
    expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
  })

  it('does not resume a session that meanwhile started in another tab', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }
    expect(getPaneSpawnDeferral(paneKey)).toBeDefined()

    const otherLeaf = '22222222-2222-4222-8222-222222222222'
    mockStoreState.agentStatusByPaneKey[makePaneKey('tab-2', otherLeaf)] = {
      paneKey: makePaneKey('tab-2', otherLeaf),
      agentType: 'claude',
      providerSession: RESUME,
      state: 'working'
    }
    mockStoreState = {
      ...mockStoreState,
      ptyIdsByTabId: { ...mockStoreState.ptyIdsByTabId, 'tab-2': ['pty-elsewhere'] },
      terminalLayoutsByTabId: {
        ...mockStoreState.terminalLayoutsByTabId,
        'tab-2': {
          root: { type: 'leaf', leafId: otherLeaf },
          activeLeafId: otherLeaf,
          expandedLeafId: null
        }
      }
    }
    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(20)

    expect(freshSpawns(transport)).toHaveLength(1)
    expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
    binding.dispose()
  })

  it('stays the owner while its retry is in flight, then hands over to the PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral, isPaneSpawnDeferred } =
      await import('@/lib/pane-spawn-deferral-registry')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }

    let bind: (ptyId: string) => void = () => {}
    transport.connect.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          bind = resolve
        })
    )
    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(5)

    expect(isPaneSpawnDeferred(paneKey)).toBe(true)
    expect(getPaneSpawnDeferral(paneKey)?.resuming).toBe(true)
    bind('resumed-pty')
    await flushAsyncTicks(20)
    expect(isPaneSpawnDeferred(paneKey)).toBe(false)
    binding.dispose()
  })

  it('does not resume a session another tab has already queued', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = deferringTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }
    mockStoreState.pendingStartupByTabId = {
      'tab-9': { command: 'claude', launchAgent: 'claude', resumeProviderSession: RESUME }
    }
    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(20)

    expect(freshSpawns(transport)).toHaveLength(1)
    binding.dispose()
  })

  it('offers to clear a crash pause on the host, then resumes the pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
    const transport = deferringTransport('paused')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const paneKey = makePaneKey('tab-1', pane.leafId)
    const deps = createDeps({
      isVisibleRef: { current: true },
      startup: {
        command: "claude '--resume' 'provider-session-1'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    })

    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    await flushAsyncTicks(20)
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await expectRestoreAskedMainNotDeferred(transport, makePaneKey('tab-1', pane.leafId))
      binding.dispose()
      return
    }

    expect(canResumeHostAutomaticRestores).toHaveBeenCalledWith(null)
    // A crash pause waits for the user; nothing retries it in the background.
    expect(drain.queued.has(paneKey)).toBe(false)
    const offer = getPaneSpawnDeferral(paneKey)?.resumeAutomaticRestores
    expect(offer).toBeTypeOf('function')
    transport.connect.mockImplementation(async () => 'resumed-pty')
    offer?.()
    await flushAsyncTicks(20)

    expect(resumeHostAutomaticRestores).toHaveBeenCalledWith(null)
    expect(freshSpawns(transport)).toHaveLength(2)
    expect(getPaneSpawnDeferral(paneKey)).toBeUndefined()
    binding.dispose()
  })
})
