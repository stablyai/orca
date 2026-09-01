import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { connectPanePty } from './pty-connection'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'

const {
  notifyCodexPaneBoundForStaleSweep,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo
} = vi.hoisted(() => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

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

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

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

describe('connectPanePty split cwd resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('waits for inherited cwd before fresh spawn and applies the resolved directory', async () => {
    const cwd = createDeferred<string>()
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      buildPaneConnectionDeps(() => mockStoreState, { cwdPromise: cwd.promise }) as never
    )
    await flushAsyncTicks(20)

    expect(createdTransportOptions[0]?.bufferInputUntilConnect).toBe(true)
    expect(transport.connect).not.toHaveBeenCalled()

    cwd.resolve('/resolved/source-cwd')
    await flushAsyncTicks(20)

    expect(createdTransportOptions[0]?.cwd).toBe('/resolved/source-cwd')
    expect(transport.connect).toHaveBeenCalledOnce()
    binding.dispose()
  })

  it('cancels the pending spawn when the split closes before cwd resolution', async () => {
    const cwd = createDeferred<string>()
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      buildPaneConnectionDeps(() => mockStoreState, { cwdPromise: cwd.promise }) as never
    )
    await flushAsyncTicks(20)
    binding.dispose()

    cwd.resolve('/resolved/too-late')
    await flushAsyncTicks(20)

    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('releases the deferred cwd fence when direct SSH authority changes during spawn', async () => {
    const cwd = createDeferred<string>()
    const spawn = createDeferred<string>()
    const transport = createMockTransport()
    const stalePtyId = toAppSshPtyId('target-a', 'pty-stale-split')
    const livePtyId = toAppSshPtyId('target-a', 'pty-live')
    let transportPtyId: string | null = null
    transport.connect.mockReturnValueOnce(spawn.promise)
    transport.getPtyId.mockImplementation(() => transportPtyId)
    transport.disconnect.mockImplementation(() => {
      transportPtyId = null
    })
    transportFactoryQueue.push(transport)
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
      directSshLivePtyBindingByTabId: {
        'tab-1': {
          attemptId: 'attempt-live-split',
          authority: {
            targetId: 'target-a',
            providerEpoch: 'epoch-old',
            connectionGeneration: 3
          },
          tabGeneration: 7,
          ptyId: livePtyId
        }
      },
      settleDirectSshPaneRetry: vi.fn()
    }
    const onDeferredCwdSpawnFailed = vi.fn()
    const paneTransportsRef = {
      current: new Map([[1, createMockTransport(livePtyId)]])
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(2) as never,
      buildPaneConnectionDeps(() => mockStoreState, {
        cwdPromise: cwd.promise,
        onDeferredCwdSpawnFailed,
        paneTransportsRef
      }) as never
    )
    await flushAsyncTicks(20)

    expect(transport.connect).not.toHaveBeenCalled()
    cwd.resolve('/resolved/source-cwd')
    await flushAsyncTicks(20)
    expect(transport.connect).toHaveBeenCalledOnce()

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
    expect(onPtySpawn).toBeTypeOf('function')
    transportPtyId = stalePtyId
    onPtySpawn?.(stalePtyId)
    await flushAsyncTicks()

    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(onDeferredCwdSpawnFailed).not.toHaveBeenCalled()

    spawn.resolve(stalePtyId)
    await flushAsyncTicks(20)

    expect(onDeferredCwdSpawnFailed).toHaveBeenCalledOnce()
    binding.dispose()
  })
})
