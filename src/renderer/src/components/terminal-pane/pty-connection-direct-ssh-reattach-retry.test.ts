import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, buildDirectSshSplitRetryCommit } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
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
    await restoreTerminalTestGlobals()
  })

  it('times out an exact direct SSH retry when reattach stays pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { connectPanePty } = await import('./pty-connection')
    const pendingReattach = createDeferred<null>()
    const transport = createMockTransport()
    transport.connect.mockReturnValueOnce(pendingReattach.promise).mockResolvedValueOnce(null)
    transportFactoryQueue.push(transport)
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-restored')
    const pendingRetry = {
      attemptId: 'attempt-reattach-timeout',
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
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks(12)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: restoredPtyId })
    )
    await vi.advanceTimersByTimeAsync(31_000)
    expect(settleDirectSshPaneRetry).toHaveBeenCalledExactlyOnceWith({
      status: 'timed-out',
      tabId: 'tab-1',
      attemptId: pendingRetry.attemptId,
      authority: pendingRetry.authority,
      tabGeneration: pendingRetry.tabGeneration
    })
    expect(transport.disconnect).not.toHaveBeenCalled()

    pendingReattach.resolve(null)
    await flushAsyncTicks(12)
  })

  it('commits a successful direct SSH reattach with its exact retry lease', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-restored')
    const transport = createMockTransport(restoredPtyId)
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-reattach-success',
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
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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
    const deps = createDeps()

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        ...deps,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks(12)

    expect(deps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      restoredPtyId,
      undefined,
      pendingRetry.attemptId
    )
    // Why: binding a reattached PTY is what lifts the pane's retirement fence, so a
    // pane re-attached mid-turn or idle is not suppressed forever (STA-4114).
    expect(mockStoreState.restoreAgentPaneAuthority).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1)
    )
  })

  // Why both directions: #15166 dropped #14844's reconnect model-paint gate and pinned the
  // degraded relay-only paint here. The gate's contract is that the relay wins only when the
  // replay SHOWS the app left the alternate screen, so pin the veto and its absence together.
  async function reconnectWithAltScreenModel(
    replay: string
  ): Promise<{ writes: string[]; transport: MockTransport }> {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-restored-relay')
    const transport = createMockTransport(restoredPtyId)
    transport.connect.mockResolvedValue({
      id: restoredPtyId,
      isReattach: true,
      replay
    })
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-relay-restore',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: 'MODEL-ALT-FRAME',
      cols: 120,
      rows: 40,
      source: 'headless',
      alternateScreen: true,
      pendingEscapeTailAnsi: '\x1b[?104'
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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
    const pane = createPane(1)
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks(20)
    return { writes, transport }
  }

  it('paints a reconnect from the alt-screen model when the replay shows no alt-screen exit', async () => {
    // The tail begins mid-escape — the ESC of its `?1049l` was evicted with the bytes before
    // it — so it carries no readable transition and cannot rebuild the frame it no longer
    // holds. Known limit of lastAlternateScreenTransition, and the model is the better paint.
    const { writes, transport } = await reconnectWithAltScreenModel('9l\r\n$ real-shell-output')

    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalled()
    expect(writes.join('')).toContain('MODEL-ALT-FRAME')
    expect(transport.resize).not.toHaveBeenCalledWith(119, 40)
  })

  it('paints a reconnect from the alt-screen model when the relay has no replay', async () => {
    const { writes } = await reconnectWithAltScreenModel('')

    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(writes.join('')).toContain('MODEL-ALT-FRAME')
  })

  it('uses the SSH relay replay for a reconnect once the replay shows the app left alt screen', async () => {
    const { writes } = await reconnectWithAltScreenModel('\x1b[?1049l\r\n$ real-shell-output')

    // Vetoed before the probe is even issued: the model still reports alternateScreen because
    // it never consumed those bytes, so painting it would freeze a dead frame AND discard the
    // shell output only the replay holds.
    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(writes.join('')).toContain('real-shell-output')
    expect(writes.join('')).not.toContain('MODEL-ALT-FRAME')
  })

  it('rejects expired reattach state after its direct SSH retry lease is revoked', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-stale-reattach')
    const pendingReattach = createDeferred<{
      id: string
      sessionExpired: true
      launchAgent: 'codex'
      launchConfig: { agentCommand: string; agentArgs: string; agentEnv: Record<string, string> }
    }>()
    const transport = createMockTransport(restoredPtyId)
    transport.connect.mockReturnValueOnce(pendingReattach.promise)
    transport.detach = vi.fn()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-stale-reattach',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-old',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const deps = createDeps()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry: vi.fn()
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        ...deps,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ admitPtyId: expect.any(Function) })
    )
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
    mockStoreState.directSshPaneRetryByTabId = {}

    pendingReattach.resolve({
      id: restoredPtyId,
      sessionExpired: true,
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: 'codex --profile stale',
        agentArgs: '--profile stale',
        agentEnv: {}
      }
    })
    await flushAsyncTicks(12)

    expect(transport.detach).toHaveBeenCalledExactlyOnceWith({ preserveExitObserver: false })
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalled()
    expect(mockStoreState.tabsByWorktree['wt-1']).toEqual([
      { id: 'tab-1', ptyId: restoredPtyId, generation: 7 }
    ])
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it('rejects stale reattach errors after its exact retry lease is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-stale-empty-reattach')
    const pendingReattach = createDeferred<void>()
    const transport = createMockTransport(restoredPtyId)
    transport.connect.mockImplementationOnce(
      (options: { admitPtyId?: (ptyId: string) => boolean; callbacks?: ConnectCallbacks }) => {
        expect(options.admitPtyId?.(restoredPtyId)).toBe(true)
        return pendingReattach.promise
      }
    )
    transport.detach = vi.fn()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-stale-empty-reattach',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-old',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const deps = createDeps()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry: vi.fn()
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        ...deps,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks()
    mockStoreState.directSshPaneRetryByTabId = {
      'tab-1': { ...pendingRetry, attemptId: 'attempt-current-reattach' }
    }

    const connectOptions = transport.connect.mock.calls[0]?.[0] as {
      callbacks?: ConnectCallbacks
    }
    connectOptions.callbacks?.onError?.('stale reattach failure')
    connectOptions.callbacks?.onError?.('SSH_SESSION_EXPIRED: stale reattach')
    pendingReattach.resolve()
    await flushAsyncTicks(12)

    expect(transport.detach).toHaveBeenCalledExactlyOnceWith({ preserveExitObserver: false })
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it('rejects a reattach failure after its direct SSH retry lease is revoked', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const restoredPtyId = toAppSshPtyId('target-a', 'pty-stale-rejected-reattach')
    const pendingReattach = createDeferred<void>()
    const transport = createMockTransport(restoredPtyId)
    transport.connect.mockImplementationOnce(
      (options: { admitPtyId?: (ptyId: string) => boolean }) => {
        expect(options.admitPtyId?.(restoredPtyId)).toBe(true)
        return pendingReattach.promise
      }
    )
    transport.detach = vi.fn()
    transportFactoryQueue.push(transport)
    const pendingRetry = {
      attemptId: 'attempt-stale-rejected-reattach',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-old',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const deps = createDeps()
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [restoredPtyId] },
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
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry },
      settleDirectSshPaneRetry: vi.fn()
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        ...deps,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      }) as never
    )
    await flushAsyncTicks()
    mockStoreState.directSshPaneRetryByTabId = {}

    pendingReattach.reject(new Error('stale reattach rejection'))
    await flushAsyncTicks(12)

    expect(transport.detach).toHaveBeenCalledExactlyOnceWith({ preserveExitObserver: false })
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  })

  it('commits every concurrent split-pane reattach under one exact retry attempt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const firstPtyId = toAppSshPtyId('target-a', 'pty-restored-first')
    const siblingPtyId = toAppSshPtyId('target-a', 'pty-restored-sibling')
    transportFactoryQueue.push(createMockTransport(firstPtyId), createMockTransport(siblingPtyId))
    const pendingRetry = {
      attemptId: 'attempt-split-reattach',
      authority: {
        targetId: 'target-a',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    const updateTabPtyId = createDirectSshSplitRetryCommit()
    const restoredPtyIdByLeafId = {
      [LEAF_1]: firstPtyId,
      [LEAF_2]: siblingPtyId
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: firstPtyId, generation: 7 }]
      },
      ptyIdsByTabId: { 'tab-1': [firstPtyId, siblingPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_1 },
            second: { type: 'leaf', leafId: LEAF_2 }
          },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: restoredPtyIdByLeafId
        }
      },
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
      createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId,
        updateTabPtyId
      }) as never
    )
    connectPanePty(
      createPane(2) as never,
      manager as never,
      createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId,
        updateTabPtyId
      }) as never
    )
    await flushAsyncTicks(12)

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
    expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual(
      restoredPtyIdByLeafId
    )
  })

  // Why: hidden panes (orchestration workers, CLI terminal create) legitimately connect at 0×0 and refit when shown, so the zero-dimensions diagnostic must stay silent.
})
