import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_REATTACH_RESET,
  RESET_GRAPHIC_RENDITION
} from '../../../../shared/terminal-mode-reset-profiles'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { createRect } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
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
  scheduleImagePasteWebglAtlasRecovery
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

  it('replays attach buffer for deferred SSH reattach and clears stale tab session metadata', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('leaf-session')
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      const id = opts.sessionId ?? 'pty-new'
      transport.getPtyId.mockReturnValue(id)
      return { id, replay: 'restored-ssh-output' }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'tab-level-stale-session' }
    }

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'leaf-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const settlePaneSerializer = vi.mocked(window.api.pty.settlePaneSerializer)
    expect(parseCallbacks.length).toBeGreaterThan(0)
    expect(settlePaneSerializer).not.toHaveBeenCalled()
    for (let step = 0; step < 20 && settlePaneSerializer.mock.calls.length === 0; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks()
    }
    expect(settlePaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: { connect: ReturnType<typeof vi.fn> }
            pty: { signal: ReturnType<typeof vi.fn> }
          }
        }
      }
    ).window.api
    expect(api.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-session' })
    )
    expect(mockStoreState.removeDeferredSshSessionId).toHaveBeenCalledWith('tab-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'leaf-session')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'leaf-session')
    // Why: the relay's replay buffer holds full history, so clear xterm before writing to avoid duplicating prior-session content.
    expect(writes).toContain(`${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`)
    expect(writes).toContain('restored-ssh-output')
    expect(writes).toContain(POST_REPLAY_REATTACH_RESET)
    expect(api.pty.signal).toHaveBeenCalledWith('leaf-session', 'SIGWINCH')
  })

  it('keeps a too-wide parked SSH alt frame while no live process can repaint it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-1')
    const sshConnect = createDeferred<SshConnectionState | null>()
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.mocked(window.api.ssh.connect).mockReturnValue(sshConnect.promise)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: 'PARKED-SSH-PAINTED-WITHOUT-NETWORK\r\n',
      cols: 140,
      rows: 31,
      seq: 123,
      source: 'headless',
      alternateScreen: true,
      scrollbackAnsi: 'PARKED-SSH-SCROLLBACK\r\n'
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: sshPtyId }] },
      ptyIdsByTabId: { 'tab-1': [sshPtyId] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId }
    }

    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
    const { writes } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        mountFollowsTerminalPark: true,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
      }) as never
    )
    await flushAsyncTicks(20)

    expect(window.api.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledOnce()
    // No live SSH process can repaint this preconnect frame after a SIGWINCH.
    expect(writes.join('')).toContain('PARKED-SSH-PAINTED-WITHOUT-NETWORK')
    expect(transport.connect).not.toHaveBeenCalled()

    binding.dispose()
    sshConnect.resolve({
      targetId: 'conn-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
  })

  it('drops an in-flight parked SSH prepaint after its retry lease is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-1')
    const snapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
    }>()
    const sshConnect = createDeferred<SshConnectionState | null>()
    const pendingRetry = {
      attemptId: 'attempt-prepaint',
      authority: {
        targetId: 'conn-1',
        providerEpoch: 'epoch-1',
        connectionGeneration: 3
      },
      tabGeneration: 7,
      startedAt: 1
    }
    transportFactoryQueue.push(createMockTransport())
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockReturnValue(snapshot.promise)
    vi.mocked(window.api.ssh.connect).mockReturnValue(sshConnect.promise)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: sshPtyId, generation: 7 }] },
      ptyIdsByTabId: { 'tab-1': [sshPtyId] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([
        [
          'conn-1',
          {
            status: 'disconnected',
            providerEpoch: 'epoch-1',
            connectionGeneration: 3
          }
        ]
      ]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId },
      directSshPaneRetryByTabId: { 'tab-1': pendingRetry }
    }

    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        mountFollowsTerminalPark: true,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
      }) as never
    )
    await flushAsyncTicks(8)
    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledOnce()

    mockStoreState.sshConnectionStates = new Map([
      [
        'conn-1',
        {
          status: 'disconnected',
          providerEpoch: 'epoch-1',
          connectionGeneration: 4
        }
      ]
    ])
    mockStoreState.directSshPaneRetryByTabId = {
      'tab-1': {
        ...pendingRetry,
        attemptId: 'attempt-prepaint-new',
        authority: { ...pendingRetry.authority, connectionGeneration: 4 }
      }
    }
    snapshot.resolve({
      data: 'OBSOLETE-LEASE-SNAPSHOT\r\n',
      cols: 101,
      rows: 31,
      seq: 124,
      source: 'headless'
    })
    await flushAsyncTicks(12)

    expect(writes.join('')).not.toContain('OBSOLETE-LEASE-SNAPSHOT')
    binding.dispose()
    sshConnect.resolve(null)
    await flushAsyncTicks(4)
  })

  it('does not prepaint a parked SSH snapshot owned by another connection', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const foreignPtyId = toAppSshPtyId('conn-2', 'relay-pty-1')
    const sshConnect = createDeferred<SshConnectionState | null>()
    transportFactoryQueue.push(createMockTransport())
    vi.mocked(window.api.ssh.connect).mockReturnValue(sshConnect.promise)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: 'FOREIGN-CONNECTION-SNAPSHOT\r\n',
      cols: 101,
      rows: 31,
      seq: 125,
      source: 'headless'
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: foreignPtyId }] },
      ptyIdsByTabId: { 'tab-1': [foreignPtyId] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': foreignPtyId }
    }

    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        mountFollowsTerminalPark: true,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: foreignPtyId }
      }) as never
    )
    await flushAsyncTicks(12)

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(writes.join('')).not.toContain('FOREIGN-CONNECTION-SNAPSHOT')
    binding.dispose()
    sshConnect.resolve(null)
    await flushAsyncTicks(4)
  })

  it('does not paint a delayed parked snapshot over an expired-session replacement', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-expired')
    const freshPtyId = toAppSshPtyId('conn-1', 'relay-pty-fresh')
    const snapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
      source: 'headless'
    }>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts) => {
      if (opts.sessionId) {
        opts.callbacks?.onError?.(`SSH_SESSION_EXPIRED: ${opts.sessionId}`)
        return undefined
      }
      transport.getPtyId.mockReturnValue(freshPtyId)
      return freshPtyId
    })
    transportFactoryQueue.push(transport)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockReturnValue(snapshot.promise)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: sshPtyId }] },
      ptyIdsByTabId: { 'tab-1': [sshPtyId] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId }
    }

    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        mountFollowsTerminalPark: true,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
      }) as never
    )
    await flushAsyncTicks(30)
    expect(transport.connect).toHaveBeenCalledTimes(2)

    snapshot.resolve({
      data: 'EXPIRED-SESSION-SNAPSHOT\r\n',
      cols: 101,
      rows: 31,
      seq: 126,
      source: 'headless'
    })
    await flushAsyncTicks(20)

    expect(writes.join('')).not.toContain('EXPIRED-SESSION-SNAPSHOT')
    binding.dispose()
  })

  it('restores configured paired scrollback after an ordinary park reveal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const remotePtyId = 'remote:env-1@@terminal-1'
    const transport = createMockTransport(remotePtyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      transport.getPtyId.mockReturnValue(remotePtyId)
      callbacks.onReplayData?.('current screen from initial subscribe\r\n')
      return { id: remotePtyId, isReattach: true, replay: '' }
    })
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: 'DEEP_PAIRED_SCROLLBACK\r\ncurrent screen\r\n',
      cols: 100,
      rows: 30,
      seq: 4_096,
      source: 'headless'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
            checkedAt: Date.now(),
            status: { capabilities: ['terminal.paired-parking.v1'] }
          }
        ]
      ])
    }

    const pane = createPane(1)
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({ mountFollowsTerminalPark: true })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    for (let step = 0; step < 30; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }

    expect(transport.serializeBuffer).toHaveBeenCalledWith({ scrollbackRows: 5000 })
    expect(transport.attach).not.toHaveBeenCalled()
    expect(writes.join('')).toContain('DEEP_PAIRED_SCROLLBACK')
    expect(writes.join('')).toContain('current screen from initial subscribe')
    expect(transport.getPtyId).toHaveReturnedWith(remotePtyId)
  })

  it('keeps a parked main-model alt frame at its capture grid while hidden', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const localPtyId = 'global-floating-terminal@@terminal-1'
    const transport = createMockTransport(localPtyId)
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      transport.getPtyId.mockReturnValue(localPtyId)
      return sessionId ? { id: localPtyId, isReattach: true } : null
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    getMainBufferSnapshot.mockResolvedValue({
      data: 'FLOATING-PARK-ALT-FRAME',
      frameRestoreAnsi: '\x1b[?25l',
      cols: 113,
      rows: 32,
      seq: 558,
      source: 'headless',
      alternateScreen: true,
      scrollbackAnsi: 'FLOATING-PARK-HISTORY\r\n'
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'global-floating-terminal': [{ id: 'tab-1', ptyId: localPtyId }]
      },
      ptyIdsByTabId: { 'tab-1': [localPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: localPtyId }
        }
      }
    }

    const pane = createPane(1)
    pane.container.getBoundingClientRect = vi.fn(() => createRect(0, 0))
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      mountFollowsTerminalPark: true,
      worktreeId: 'global-floating-terminal',
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: localPtyId }
    })
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    for (let step = 0; step < 30; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }

    expect(getMainBufferSnapshot).toHaveBeenCalledOnce()
    expect(getMainBufferSnapshot).toHaveBeenCalledWith(localPtyId, { scrollbackRows: 5000 })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: localPtyId })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, localPtyId)
    expect(writes.join('')).toContain('FLOATING-PARK-HISTORY')
    expect(writes.join('')).toContain('FLOATING-PARK-ALT-FRAME')
    expect(writes.filter((write) => write.includes('FLOATING-PARK-ALT-FRAME'))).toHaveLength(1)
    expect(pane.terminal.resize).toHaveBeenCalledWith(113, 32)
  })

  it('restores a parked SSH alt frame after StrictMode watcher disposal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-static-alt')
    const transport = createMockTransport(sshPtyId)
    transport.connect.mockImplementation(async () => {
      transport.getPtyId.mockReturnValue(sshPtyId)
      return { id: sshPtyId, isReattach: true, replay: '' }
    })
    transportFactoryQueue.push(transport)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: '\x1b[0m\x1b[?1049h\x1b[HSTATIC-SSH-ALT-FRAME',
      frameRestoreAnsi: '\x1b[0m\x1b[?1049h\x1b[?6l\x1b[1;21H',
      cols: 100,
      rows: 30,
      seq: 512,
      source: 'headless',
      alternateScreen: true,
      scrollbackAnsi: 'PRESERVED-SSH-HISTORY\r\n'
    })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId }
    }

    const pane = createPane(1)
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      mountFollowsTerminalPark: true,
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
    })
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    for (let step = 0; step < 30; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }

    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledOnce()
    expect(writes.join('')).toContain('PRESERVED-SSH-HISTORY')
    expect(writes.filter((write) => write.includes('STATIC-SSH-ALT-FRAME'))).toHaveLength(1)
  })

  it('falls back to relay replay when the SSH model snapshot stalls', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS } = await import('./ssh-reattach-model-restore')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-1')
    const transport = createMockTransport(sshPtyId)
    transport.connect.mockImplementation(async () => {
      transport.getPtyId.mockReturnValue(sshPtyId)
      return { id: sshPtyId, isReattach: true, replay: 'relay-fallback-output' }
    })
    transportFactoryQueue.push(transport)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockReturnValue(new Promise(() => {}))
    // Why parked: only a reveal remount probes main's model.

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId }
    }

    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      mountFollowsTerminalPark: true,
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledWith(sshPtyId, {
      scrollbackRows: 5000
    })
    expect(writes).not.toContain('relay-fallback-output')

    await new Promise((resolve) => setTimeout(resolve, SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS + 25))
    await flushAsyncTicks(20)

    expect(writes).toContain('relay-fallback-output')
    // Why: a stalled reveal must cost exactly one bounded probe — a re-probe
    // would buy a second timeout window before the relay paint.
    expect(window.api.pty.getMainBufferSnapshot).toHaveBeenCalledTimes(1)
  })

  // Why: the model probe exists to beat the relay's 100KiB tail on a park-reveal.
  // An ordinary reattach (network reconnect, wake, reload) already holds that
  // replay, so probing would only delay its paint by the timeout.
  it('paints the relay replay without probing main when the reattach did not follow a park', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('conn-1', 'relay-pty-1')
    const transport = createMockTransport(sshPtyId)
    transport.connect.mockImplementation(async () => {
      transport.getPtyId.mockReturnValue(sshPtyId)
      return { id: sshPtyId, isReattach: true, replay: 'relay-reconnect-output' }
    })
    transportFactoryQueue.push(transport)
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockReturnValue(new Promise(() => {}))

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': sshPtyId }
    }

    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(writes).toContain('relay-reconnect-output')
  })
})
