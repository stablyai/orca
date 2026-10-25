import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { expectMainFrameClosesExitedSplitPaneOnce } from './pty-connection-test-exited-split-pane-close'
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
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

export function registerPtyConnectionSessionLivenessTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function seedUnverifiableRestoredPane() {
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'unverifiable-pty' }] },
      ptyIdsByTabId: { 'tab-1': ['unverifiable-pty'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: 'unverifiable-pty' }
        }
      }
    } as StoreState
    return createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'unverifiable-pty' }
    })
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
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
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))

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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
        binding.reconcileIfSessionMissing(hasPty)
        transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
        resolveHasPty(false)
        await flushAsyncTicks()

        expect(manager.closePane).not.toHaveBeenCalled()
        expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      })

      it('does NOT tear down a newborn pane when liveness was requested before it bound', async () => {
        // Why (regression): a liveness request made before the spawn bound cannot prove the fresh ptyId dead (boundAt wiring).
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
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
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-1')
        transportFactoryQueue.push(transport)
        const manager = createManager(1)
        const deps = createDeps()

        const binding = connectPanePty(...mockPanePtyArgs(createPane(1), manager, deps))

        // The last pane reattaches to the tab's persisted ptyId ('tab-pty'); let that bind first.
        await flushAsyncTicks()
        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

        expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', 0)
        expect(manager.closePane).not.toHaveBeenCalled()
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()

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

        connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
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

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
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
          // The racing exit must not re-run the teardown that registered main's close.
          expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledTimes(1)
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
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

        const binding = connectPanePty(...mockPanePtyArgs(createPane(2), manager, deps))
        capturedDataCallback.current?.('shell prompt')
        const onPtyExit = createdTransportOptions[0]?.onPtyExit as
          | ((ptyId: string) => void)
          | undefined

        binding.reconcileIfSessionMissing(async () => false)
        await flushAsyncTicks()
        onPtyExit?.('pty-pane-2')

        // Observable outcome: single close, pane was treated as dead (closed).
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledTimes(1)
          await expectMainFrameClosesExitedSplitPaneOnce(manager)
        } else {
          expect(manager.closePane).toHaveBeenCalledTimes(1)
          expect(manager.closePane).toHaveBeenCalledWith(2)
        }
      })
    })

    it('preserves an owner-unverified restored pane after an empty reattach result', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
        opts.callbacks?.onError?.('terminal_pane_owner_unverified')
        return undefined
      })
      transportFactoryQueue.push(transport)
      const deps = seedUnverifiableRestoredPane()

      connectPanePty(...mockPanePtyArgs(createPane(2), createManager(2), deps))
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(2, 'terminal_pane_owner_unverified')
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(mockStoreState.tabsByWorktree['wt-1'][0]?.ptyId).toBe('unverifiable-pty')
      expect(mockStoreState.ptyIdsByTabId?.['tab-1']).toEqual(['unverifiable-pty'])
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
        [LEAF_2]: 'unverifiable-pty'
      })
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)
    })

    it('preserves an owner-unverified restored pane after a rejected reattach', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transport.connect.mockRejectedValueOnce(new Error('terminal_pane_owner_unverified'))
      transportFactoryQueue.push(transport)
      const deps = seedUnverifiableRestoredPane()

      connectPanePty(...mockPanePtyArgs(createPane(2), createManager(2), deps))
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(2, 'terminal_pane_owner_unverified')
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
        [LEAF_2]: 'unverifiable-pty'
      })
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)
    })

    it.each([false, true])(
      'preserves an exhausted pane until explicit Retry and clears only the current owner error (fresh: %s)',
      async (fresh) => {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport()
        transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
          opts.callbacks?.onError?.('terminal_pane_owner_changed')
          return undefined
        })
        transportFactoryQueue.push(transport)
        const deps = fresh ? createDeps() : seedUnverifiableRestoredPane()
        const cleared = vi.fn()
        deps.onPtyErrorClearedRef = { current: cleared }

        connectPanePty(...mockPanePtyArgs(createPane(2), createManager(2), deps))
        await flushAsyncTicks()

        expect(transport.connect).toHaveBeenCalledTimes(1)
        expect(deps.onPtyErrorRef.current).toHaveBeenCalledExactlyOnceWith(
          2,
          'terminal_pane_owner_changed'
        )
        expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
        expect(deps.clearTabPtyId).not.toHaveBeenCalled()
        if (!fresh) {
          expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
            [LEAF_2]: 'unverifiable-pty'
          })
        }
        const stale = transport.connect.mock.calls[0]?.[0].callbacks
        transport.connect.mockImplementation(async ({ callbacks }) => {
          callbacks?.onError?.('unrelated diagnostic')
          callbacks?.onConnect?.()
          return { id: 'unverifiable-pty', isReattach: true }
        })
        expect(transport.retryRecovery?.()).toBe(true)
        await flushAsyncTicks()
        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.disconnect).not.toHaveBeenCalled()
        expect(cleared).toHaveBeenCalledExactlyOnceWith(2, 'terminal_pane_owner_changed')
        stale?.onError?.('terminal_pane_owner_changed')
        expect(
          deps.onPtyErrorRef.current.mock.calls.filter(
            ([, message]) => message === 'terminal_pane_owner_changed'
          )
        ).toHaveLength(1)
      }
    )

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
        const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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
}
