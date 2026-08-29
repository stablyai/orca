import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, buildDirectSshSplitRetryCommit } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey
} from './pty-connection/pty-connect-limits'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
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

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
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

function createDirectSshSplitRetryCommit() {
  return buildDirectSshSplitRetryCommit(() => mockStoreState)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    pendingSpawnByPaneKey.clear()
    pendingSpawnGenerationByPaneKey.clear()
    await restoreTerminalTestGlobals()
  })

  it('does not retain PTY connect diagnostics unless e2e debug state is enabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect((globalThis as Record<string, unknown>).__ptyConnectDiag).toBeUndefined()
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[pty-connect]'))
    logSpy.mockRestore()
  }, 30_000)

  it('does not hold a successor behind a canceled spawn serializer declaration', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const declaration = createDeferred<number>()
    const spawn = createDeferred<null>()
    const transport = createMockTransport()
    transport.connect.mockReturnValueOnce(spawn.promise)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }
    vi.mocked(window.api.pty.declarePendingPaneSerializer).mockReturnValueOnce(declaration.promise)

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks(12)
    binding.dispose()
    spawn.resolve(null)
    await flushAsyncTicks(12)

    expect(pendingSpawnByPaneKey.size).toBe(0)
    expect(window.api.pty.clearPendingPaneSerializer).not.toHaveBeenCalled()

    declaration.resolve(7)
    await flushAsyncTicks(12)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      7
    )
  })

  it.each(['rejects', 'resolves empty'] as const)(
    'settles the exact direct SSH retry when its fresh spawn %s',
    async (outcome) => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      if (outcome === 'rejects') {
        transport.connect.mockRejectedValueOnce(new Error('spawn failed'))
      } else {
        transport.connect.mockResolvedValueOnce(null)
      }
      transportFactoryQueue.push(transport)
      const settleDirectSshPaneRetry = vi.fn()
      const pendingRetry = {
        attemptId: 'attempt-1',
        authority: {
          targetId: 'target-a',
          providerEpoch: 'epoch-1',
          connectionGeneration: 3
        },
        tabGeneration: 7,
        startedAt: 1
      }
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
        ptyIdsByTabId: { 'tab-1': [] },
        repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
        sshConnectionStates: new Map([
          [
            'target-a',
            {
              targetId: 'target-a',
              status: 'connected',
              providerEpoch: 'epoch-1',
              connectionGeneration: 3
            }
          ]
        ]),
        directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
        settleDirectSshPaneRetry
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(12)

      expect(settleDirectSshPaneRetry).toHaveBeenCalledExactlyOnceWith({
        status: 'failed',
        tabId: 'tab-1',
        attemptId: pendingRetry.attemptId,
        authority: pendingRetry.authority,
        tabGeneration: pendingRetry.tabGeneration
      })
    }
  )

  it('times out an exact direct SSH retry when a StrictMode-reused spawn stays pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { connectPanePty } = await import('./pty-connection')
    const pendingSpawn = createDeferred<null>()
    const firstTransport = createMockTransport()
    firstTransport.connect.mockReturnValueOnce(pendingSpawn.promise)
    const remountTransport = createMockTransport()
    transportFactoryQueue.push(firstTransport, remountTransport)
    const pendingRetry = {
      attemptId: 'attempt-timeout',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const settleDirectSshPaneRetry = vi.fn(() => {
      mockStoreState.directSshPaneRetryByTabId = {}
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry
    }

    const firstBinding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks()
    firstBinding.dispose()
    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(firstTransport.connect).toHaveBeenCalledOnce()
    expect(remountTransport.connect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_999)
    expect(settleDirectSshPaneRetry).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(settleDirectSshPaneRetry).toHaveBeenCalledExactlyOnceWith({
      status: 'timed-out',
      tabId: 'tab-1',
      attemptId: pendingRetry.attemptId,
      authority: pendingRetry.authority,
      tabGeneration: pendingRetry.tabGeneration
    })
    expect(firstTransport.disconnect).not.toHaveBeenCalled()
    expect(remountTransport.disconnect).not.toHaveBeenCalled()

    pendingSpawn.resolve(null)
    await flushAsyncTicks(12)
  })

  it('cancels exact retry settlement when a hung pane is intentionally disposed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { connectPanePty } = await import('./pty-connection')
    const pendingSpawn = createDeferred<null>()
    const transport = createMockTransport()
    transport.connect.mockReturnValueOnce(pendingSpawn.promise)
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-disposed',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const settleDirectSshPaneRetry = vi.fn()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry
    }

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks()
    binding.dispose()
    await vi.advanceTimersByTimeAsync(31_000)

    expect(settleDirectSshPaneRetry).not.toHaveBeenCalled()

    pendingSpawn.resolve(null)
    await flushAsyncTicks(12)
    expect(settleDirectSshPaneRetry).not.toHaveBeenCalled()
  })

  it('joins a successful pending spawn across a same-attempt StrictMode remount', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pendingSpawn = createDeferred<string>()
    const firstTransport = createMockTransport()
    firstTransport.connect.mockReturnValueOnce(pendingSpawn.promise)
    const remountTransport = createMockTransport()
    transportFactoryQueue.push(firstTransport, remountTransport)
    const pendingRetry = {
      attemptId: 'attempt-strict-mode',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry: vi.fn()
    }
    const remountDeps = createDeps()

    const firstBinding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks()
    firstBinding.dispose()
    connectPanePty(createPane(1) as never, createManager(1) as never, remountDeps as never)
    await flushAsyncTicks()

    expect(firstTransport.connect).toHaveBeenCalledOnce()
    expect(remountTransport.connect).not.toHaveBeenCalled()

    const spawnedPtyId = toAppSshPtyId('target-a', 'pty-strict-mode')
    pendingSpawn.resolve(spawnedPtyId)
    await flushAsyncTicks(12)

    expect(remountTransport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: spawnedPtyId })
    )
    expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      spawnedPtyId,
      undefined,
      pendingRetry.attemptId
    )
  })

  it('commits every concurrent split-pane spawn under one exact retry attempt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const firstSpawn = createDeferred<string>()
    const siblingSpawn = createDeferred<string>()
    const firstTransport = createMockTransport()
    const siblingTransport = createMockTransport()
    firstTransport.connect.mockReturnValueOnce(firstSpawn.promise)
    siblingTransport.connect.mockReturnValueOnce(siblingSpawn.promise)
    transportFactoryQueue.push(firstTransport, siblingTransport)
    const pendingRetry = {
      attemptId: 'attempt-split-spawn',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const updateTabPtyId = createDirectSshSplitRetryCommit()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      directSshLivePtyBindingByTabId: {},
      settleDirectSshPaneRetry: vi.fn()
    }
    const manager = createManager(2)

    connectPanePty(
      createPane(1) as never,
      manager as never,
      createDeps({ updateTabPtyId }) as never
    )
    connectPanePty(
      createPane(2) as never,
      manager as never,
      createDeps({ updateTabPtyId }) as never
    )
    await flushAsyncTicks()

    const firstPtyId = toAppSshPtyId('target-a', 'pty-first')
    const siblingPtyId = toAppSshPtyId('target-a', 'pty-sibling')
    const firstOnPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const siblingOnPtySpawn = createdTransportOptions[1]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    firstOnPtySpawn?.(firstPtyId)
    siblingOnPtySpawn?.(siblingPtyId)

    expect(updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      firstPtyId,
      undefined,
      pendingRetry.attemptId
    )
    expect(updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      siblingPtyId,
      undefined,
      pendingRetry.attemptId
    )
    expect(mockStoreState.ptyIdsByTabId?.['tab-1']).toEqual([firstPtyId, siblingPtyId])

    firstSpawn.resolve(firstPtyId)
    siblingSpawn.resolve(siblingPtyId)
    await flushAsyncTicks(12)
  })

  it('captures retained live authority when a sibling mounts after first success', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const delayedSpawn = createDeferred<string>()
    const transport = createMockTransport()
    transport.connect.mockReturnValueOnce(delayedSpawn.promise)
    transportFactoryQueue.push(transport)
    const livePtyId = toAppSshPtyId('target-a', 'pty-live')
    const siblingPtyId = toAppSshPtyId('target-a', 'pty-delayed-sibling')
    const liveRetry = {
      attemptId: 'attempt-live-sibling',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      ptyId: livePtyId
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: livePtyId, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [livePtyId] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: {},
      directSshLivePtyBindingByTabId: { 'tab-1': liveRetry },
      settleDirectSshPaneRetry: vi.fn()
    }
    const paneTransportsRef = {
      current: new Map([[1, createMockTransport(livePtyId)]])
    }
    const deps = createDeps({ paneTransportsRef })

    connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
    await flushAsyncTicks()

    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.(siblingPtyId)

    expect(deps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      siblingPtyId,
      undefined,
      liveRetry.attemptId
    )

    delayedSpawn.resolve(siblingPtyId)
    await flushAsyncTicks(12)
  })

  it('rejects a delayed live-lease sibling after direct SSH authority rotates', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const delayedSpawn = createDeferred<string>()
    const transport = createMockTransport()
    const stalePtyId = toAppSshPtyId('target-a', 'pty-stale-live-sibling')
    transport.getPtyId.mockReturnValue(stalePtyId)
    transport.connect.mockReturnValueOnce(delayedSpawn.promise)
    transportFactoryQueue.push(transport)
    const livePtyId = toAppSshPtyId('target-a', 'pty-live')
    const liveRetry = {
      attemptId: 'attempt-live-stale',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-old',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      ptyId: livePtyId
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: livePtyId, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [livePtyId] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-old',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: {},
      directSshLivePtyBindingByTabId: { 'tab-1': liveRetry },
      settleDirectSshPaneRetry: vi.fn()
    }
    const paneTransportsRef = {
      current: new Map([[1, createMockTransport(livePtyId)]])
    }
    const deps = createDeps({ paneTransportsRef })

    connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
    await flushAsyncTicks()
    mockStoreState.sshConnectionStates = new Map([
      [
        'target-a',
        {
          targetId: 'target-a',
          status: 'connected',
          providerEpoch: 'epoch-new',
          connectionGeneration: 4
        }
      ]
    ])

    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.(stalePtyId)
    await flushAsyncTicks()

    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(transport.disconnect).toHaveBeenCalledOnce()

    delayedSpawn.resolve(stalePtyId)
    await flushAsyncTicks(12)
  })

  it('starts a new spawn and rejects a late callback after direct SSH authority rotates', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const oldPendingSpawn = createDeferred<string>()
    const oldTransport = createMockTransport()
    let oldTransportPtyId: string | null = null
    oldTransport.getPtyId.mockImplementation(() => oldTransportPtyId)
    oldTransport.disconnect.mockImplementation(() => {
      oldTransportPtyId = null
    })
    oldTransport.connect.mockReturnValueOnce(oldPendingSpawn.promise)
    const newPendingSpawn = createDeferred<string>()
    const newTransport = createMockTransport()
    newTransport.connect.mockReturnValueOnce(newPendingSpawn.promise)
    transportFactoryQueue.push(oldTransport, newTransport)
    const oldRetry = {
      attemptId: 'attempt-old',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-old',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const newRetry = {
      attemptId: 'attempt-new',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-new',
        connectionGeneration: 4
      },
      tabGeneration: 8,
      startedAt: 2
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'target-a', displayName: 'orca' }],
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-old',
            connectionGeneration: 3
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': oldRetry },
      settleDirectSshPaneRetry: vi.fn()
    }
    const oldDeps = createDeps()

    const oldBinding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      oldDeps as never
    )
    await flushAsyncTicks()
    oldBinding.dispose()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 8 }] },
      sshConnectionStates: new Map([
        [
          'target-a',
          {
            targetId: 'target-a',
            status: 'connected',
            providerEpoch: 'epoch-new',
            connectionGeneration: 4
          }
        ]
      ]),
      directSshPaneRetryByTabId: { 'tab-1': newRetry }
    }
    const newDeps = createDeps()

    connectPanePty(createPane(1) as never, createManager(1) as never, newDeps as never)
    await flushAsyncTicks()

    expect(oldTransport.connect).toHaveBeenCalledOnce()
    expect(newTransport.connect).toHaveBeenCalledOnce()

    const oldPtyId = toAppSshPtyId('target-a', 'pty-old')
    oldTransportPtyId = oldPtyId
    const oldOnPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    oldOnPtySpawn?.(oldPtyId)
    oldPendingSpawn.resolve(oldPtyId)
    await flushAsyncTicks(12)

    expect(oldDeps.updateTabPtyId).not.toHaveBeenCalled()
    expect(oldTransport.disconnect).toHaveBeenCalledOnce()
    expect(mockStoreState.directSshPaneRetryByTabId).toEqual({ 'tab-1': newRetry })

    const newPtyId = toAppSshPtyId('target-a', 'pty-new')
    const newOnPtySpawn = createdTransportOptions[1]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    newOnPtySpawn?.(newPtyId)
    newPendingSpawn.resolve(newPtyId)
    await flushAsyncTicks(12)

    expect(newDeps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      newPtyId,
      undefined,
      newRetry.attemptId
    )
  })
})
