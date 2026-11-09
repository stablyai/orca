import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { expectMainFrameClosesExitedSplitPaneOnce } from '../test-fixtures/pty-connection-test-exited-split-pane-close'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionSessionLivenessTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
  }
  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    describe('reconcileIfSessionMissing', () => {
      it('closes a split pane when targeted liveness says its local session is missing', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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

        const binding = connectPanePty(
          ...mockPanePtyArgs(createPane(2), manager, bindPaneAgentTitleMocks(deps, agentTitleMocks))
        )
        capturedDataCallback.current?.('shell prompt')

        binding.reconcileIfSessionMissing(hasPty)
        await flushAsyncTicks()

        expect(hasPty).toHaveBeenCalledWith('pty-pane-2')
        // Switch on: the host's authoritative absence is a confirmed end; main closes, the frame shows it.
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })

      it('does not close when targeted liveness is live or unknown', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks2)
          )
        )

        binding.reconcileIfSessionMissing(vi.fn(async () => true))
        binding.reconcileIfSessionMissing(vi.fn(async () => null))
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('does not apply a stale targeted liveness result after reattach', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks3)
          )
        )
        binding.reconcileIfSessionMissing(hasPty)
        transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
        resolveHasPty(false)
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('does NOT tear down a newborn pane when liveness was requested before it bound', async () => {
        // Liveness requested before binding cannot prove the fresh PTY dead.
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks4)
          )
        )
        // Why: clear the freshly-split early-return guard so the only remaining protection is the freshness guard under test.
        capturedDataCallback.current?.('shell prompt')
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        expect(onPtySpawn).toBeTypeOf('function')

        // Record boundAt via the spawn chokepoint; bracket it with a real timestamp.
        const beforeSpawn = performance.now()
        onPtySpawn?.('pty-pane-2')

        // requestedAt < boundAt: a stale liveness answer can't prove the fresh pane dead.
        binding.reconcileIfSessionMissing(async () => false, beforeSpawn - 1)
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('tears down the pane when liveness was requested after it bound', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks5)
          )
        )
        // Why: clear the freshly-split early-return guard so onExit reaches close.
        capturedDataCallback.current?.('shell prompt')
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        expect(onPtySpawn).toBeTypeOf('function')

        onPtySpawn?.('pty-pane-2')
        const afterSpawn = performance.now()

        // requestedAt > boundAt: the request postdates the bind, so absence is real.
        binding.reconcileIfSessionMissing(async () => false, afterSpawn + 1)
        await flushAsyncTicks()

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })

      it('routes the last pane through onPtyExitRef when its session is dead', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('pty-pane-1')
        transportFactoryQueue.push(transport)
        const manager = createManager(1)
        const deps = createDeps()

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(1),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks6)
          )
        )

        // The last pane reattaches to the tab's persisted ptyId ('tab-pty'); let that bind first.
        await flushAsyncTicks()
        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

        expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', 0)
        expect(manager.closePane).not.toHaveBeenCalled()
      })

      it('is a no-op for remote: web-runtime ids', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        enableActiveRuntimeEnvironment('env-1')
        const transport = createMockTransport('remote:env-1:pane-2')
        transport.getConnectionId.mockReturnValue(null)
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks7)
          )
        )

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('is a no-op for SSH/non-local ids (non-null connectionId)', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('pty-pane-2')
        transport.getConnectionId.mockReturnValue('ssh-target-1')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks8)
          )
        )

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('respects suppression: a suppressed dead session keeps the pane mounted', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          consumeSuppressedPtyExit: vi.fn(() => true),
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks9)
          )
        )

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

        expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('still closes the replacement PTY after a suppressed restart rebinds the pane', async () => {
        // Scope exit guards by PTY ID so a rebound replacement’s later exit still tears down.
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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
        const consumeSuppressedPtyExit = vi
          .fn<(ptyId: string) => boolean>()
          .mockImplementationOnce(() => true)
          .mockImplementation(() => false)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          consumeSuppressedPtyExit,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks10)
          )
        )
        capturedDataCallback.current?.('shell prompt')
        const onPtyExit = createdTransportOptions[0]?.onPtyExit as
          | ((ptyId: string) => void)
          | undefined

        onPtyExit?.('pty-pane-2')
        expect(manager.closePane).not.toHaveBeenCalled()

        // Restart rebinds the pane to a new live PTY; its later real exit must not be ignored by a stale guard.
        transport.getPtyId.mockReturnValue('pty-pane-2-restarted')
        onPtyExit?.('pty-pane-2-restarted')

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })

      it('closes a split pane exactly once across reconcile + a racing real exit', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks11)
          )
        )
        capturedDataCallback.current?.('shell prompt')
        const onPtyExit = createdTransportOptions[0]?.onPtyExit as
          | ((ptyId: string) => void)
          | undefined
        expect(onPtyExit).toBeTypeOf('function')

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()
        // A racing real/synthetic pty:exit for the SAME id must not close twice.
        onPtyExit?.('pty-pane-2')

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledTimes(1)
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })

      it('closes a genuinely-dead non-suppressed pane once (not misread as suppressed)', async () => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
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
          consumeSuppressedPtyExit: vi.fn(() => false),
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            manager,
            bindPaneAgentTitleMocks(deps, agentTitleMocks12)
          )
        )
        capturedDataCallback.current?.('shell prompt')
        const onPtyExit = createdTransportOptions[0]?.onPtyExit as
          | ((ptyId: string) => void)
          | undefined

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()
        onPtyExit?.('pty-pane-2')

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledTimes(1)
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })
    })
  })
}
