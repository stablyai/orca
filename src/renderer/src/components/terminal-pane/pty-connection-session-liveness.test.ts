import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
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

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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

  describe('reconcileIfSessionDead', () => {
    it('closes a split pane bound to a dead local session (same teardown as onExit)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so onExit reaches the close branch (established, used split pane).
      capturedDataCallback.current?.('shell prompt')

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))

      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('closes a split pane when targeted liveness says its local session is missing', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const hasPty = vi.fn(async () => false)

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')

      binding.reconcileIfSessionMissing(hasPty)
      await flushAsyncTicks()

      expect(hasPty).toHaveBeenCalledWith('pty-pane-2')
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('does not close when targeted liveness is live or unknown', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionMissing(vi.fn(async () => true))
      binding.reconcileIfSessionMissing(vi.fn(async () => null))
      await flushAsyncTicks()

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('does not apply a stale targeted liveness result after reattach', async () => {
      const { connectPanePty } = await import('./pty-connection')
      let resolveHasPty: (value: boolean) => void = () => {
        throw new Error('hasPty promise resolver was not initialized')
      }
      const hasPty = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveHasPty = resolve
          })
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      binding.reconcileIfSessionMissing(hasPty)
      transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
      resolveHasPty(false)
      await flushAsyncTicks()

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('does NOT tear down a newborn pane when the snapshot was requested before it bound', async () => {
      // Why (regression): a snapshot requested before the spawn bound cannot prove the fresh ptyId dead (boundAt wiring).
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so the only remaining protection is the freshness guard under test.
      capturedDataCallback.current?.('shell prompt')
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      // Record boundAt via the spawn chokepoint; bracket it with a real timestamp.
      const beforeSpawn = performance.now()
      onPtySpawn?.('pty-pane-2')

      // requestedAt < boundAt: stale snapshot can't prove the fresh pane dead.
      binding.reconcileIfSessionDead(new Set(['pty-pane-1']), beforeSpawn - 1)

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('tears down the pane when the snapshot was requested after it bound', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so onExit reaches close.
      capturedDataCallback.current?.('shell prompt')
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      onPtySpawn?.('pty-pane-2')
      const afterSpawn = performance.now()

      // requestedAt > boundAt: the snapshot postdates the bind, so absence is real.
      binding.reconcileIfSessionDead(new Set(['pty-pane-1']), afterSpawn + 1)

      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('routes the last pane through onPtyExitRef when its session is dead', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-1')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      const binding = connectPanePty(createPane(1) as never, manager as never, deps as never)

      // The last pane reattaches to the tab's persisted ptyId ('tab-pty').
      binding.reconcileIfSessionDead(new Set(['some-other-live']))

      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('is a no-op when the bound session is still live', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set(['pty-pane-1', 'pty-pane-2']))

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('is a no-op for remote: web-runtime ids', async () => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment('env-1')
      const transport = createMockTransport('remote:env-1:pane-2')
      transport.getConnectionId.mockReturnValue(null)
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set())

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('is a no-op for SSH/non-local ids (non-null connectionId)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transport.getConnectionId.mockReturnValue('ssh-target-1')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set())

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('respects suppression: a suppressed dead session keeps the pane mounted', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit: vi.fn(() => true),
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))

      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('still closes the replacement PTY after a suppressed restart rebinds the pane', async () => {
      // Why (regression): the exit guard is scoped to the exiting ptyId, not a one-shot boolean, so a rebound replacement's later real exit still tears down.
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      // First exit is suppressed (intentional restart); later exits are real.
      const consumeSuppressedPtyExit = vi
        .fn<(ptyId: string) => boolean>()
        .mockImplementationOnce(() => true)
        .mockImplementation(() => false)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      // Suppressed exit of the original PTY: pane stays mounted.
      onPtyExit?.('pty-pane-2')
      expect(manager.closePane).not.toHaveBeenCalled()

      // Restart rebinds the pane to a new live PTY; its later real exit must not be ignored by a stale guard.
      transport.getPtyId.mockReturnValue('pty-pane-2-restarted')
      onPtyExit?.('pty-pane-2-restarted')

      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('does not act on a stale id after a reattach changed the bound id', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      // Reattach between snapshot and apply: snapshot marked the OLD id dead, but getPtyId now returns the new live id.
      transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
      binding.reconcileIfSessionDead(new Set(['pty-pane-1', 'pty-pane-2-reattached']))

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('closes a split pane exactly once across reconcile + a racing real exit', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))
      // A racing real/synthetic pty:exit for the SAME id must not close twice.
      onPtyExit?.('pty-pane-2')

      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('closes a genuinely-dead non-suppressed pane once (not misread as suppressed)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      // consumeSuppressedPtyExit always returns false for this genuinely-dead id.
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit: vi.fn(() => false),
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))
      onPtyExit?.('pty-pane-2')

      // Observable outcome: single close, pane was treated as dead (closed).
      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })
  })

  describe('terminal input liveness IPC gating (perf)', () => {
    // Why (perf regression guard): listSessions() is a renderer→main→daemon round-trip; terminal input must never trigger it.
    async function connectActivePaneWithInput(): Promise<{
      binding: { noteVisibilityResume: () => void }
      transport: MockTransport
      typeKeystroke: (data?: string) => void
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      return {
        binding,
        transport,
        // Drives the real xterm onData (terminal input) handler.
        typeKeystroke: (data = 'a') => sendTerminalInputThroughPane(pane, data)
      }
    }

    it('does not fire listSessions for first input on a fresh mount', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { typeKeystroke } = await connectActivePaneWithInput()

      for (let i = 0; i < 25; i++) {
        typeKeystroke('x')
      }

      expect(listSessions).not.toHaveBeenCalled()
    })

    it('does not fire listSessions for input after a visibility resume', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { binding, typeKeystroke } = await connectActivePaneWithInput()

      binding.noteVisibilityResume()
      typeKeystroke('a')
      typeKeystroke('b')

      expect(listSessions).not.toHaveBeenCalled()
    })

    it('sends the first post-resume input without starting the liveness re-check', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const calls: string[] = []
      listSessions.mockImplementation(() => {
        calls.push('listSessions')
        return Promise.resolve([])
      })
      const { binding, transport, typeKeystroke } = await connectActivePaneWithInput()
      transport.sendInput.mockImplementation(() => {
        calls.push('sendInput')
        return true
      })

      binding.noteVisibilityResume()
      typeKeystroke('a')

      expect(calls).toEqual(['sendInput'])
    })

    it('does not re-arm input-driven listSessions across repeated visibility resumes', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { binding, typeKeystroke } = await connectActivePaneWithInput()

      binding.noteVisibilityResume()
      typeKeystroke('a')
      typeKeystroke('b')
      expect(listSessions).not.toHaveBeenCalled()

      binding.noteVisibilityResume()
      typeKeystroke('c')
      typeKeystroke('d')
      expect(listSessions).not.toHaveBeenCalled()
    })
  })
})
