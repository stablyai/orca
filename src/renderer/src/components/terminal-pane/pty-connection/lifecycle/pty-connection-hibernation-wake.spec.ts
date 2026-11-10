import { createDeferred, flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  expectNoWindowStart,
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

import {
  leafIdForPane,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'

import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionHibernationWakeTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('names the replaced PTY on the restart spawn only, never on a later wake of the same pane', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-restarted')
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId: 'tab-restart-wake',
        startup: { command: 'claude', launchAgent: 'claude' },
        replacesPtyId: 'pty-replaced',
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      })
      const pane = createPane(2)
      const args = mockPanePtyArgs(pane, createManager(1), deps)
      bindPaneAgentTitleMocks(args[2], agentTitleMocks4)

      const binding = connectPanePty(...args)
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
      const restartConnect: { claimReplacedPtyId?: () => string | null } | undefined =
        transport.connect.mock.calls[0]?.[0]
      // The IPC transport takes the id as it sends the spawn; this mock transport does it here.
      expect(restartConnect?.claimReplacedPtyId?.()).toBe('pty-replaced')
      // Why: transport options outlive the first spawn, so the field must not ride them.
      expect(createdTransportOptions[0]).not.toHaveProperty('replacesPtyId')

      const paneKey = `tab-restart-wake:${leafIdForPane(2)}`
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: bindsPaneInStore(() => mockStoreState, 'tab-restart-wake', leafIdForPane(2))
        })
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-restart-wake',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-restart-wake' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      mockStoreState.suppressedPtyExitIds['pty-restarted'] = true
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('pty-restarted')
      await flushAsyncTicks()
      expect(binding.wakeHibernatedAgentIfArmed(new Set())).not.toBeNull()
      await flushAsyncTicks()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // The wake asks main; its attach to main's terminal names no PTY to replace.
        await expectWindowStartAskedMain(transport, paneKey)
        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({
          sessionId: 'pty-main',
          attachOnlyView: true
        })
        expect(transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('claimReplacedPtyId')
        binding.dispose()
        await flushAsyncTicks()
        expect(window.api.pty.kill).not.toHaveBeenCalledWith('pty-replaced')
        return
      }

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('claimReplacedPtyId')
      expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({
        resumeSpawnIntent: 'automatic-restore'
      })
      binding.dispose()
      await flushAsyncTicks()
      expect(window.api.pty.kill).not.toHaveBeenCalledWith('pty-replaced')
    })
  })
}

export function registerPtyConnectionHibernationWakeClaimTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('latches a navigation-free wake that lands before the hibernation kill arms the pane', async () => {
      // Latch wake events between recording sleep and arming the kill’s PTY ID, or the frozen pane remains stranded (#7906).
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      })
      const pane = createPane(2)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: bindsPaneInStore(() => mockStoreState, 'tab-1', leafIdForPane(2))
        })
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated-race' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      mockStoreState.suppressedPtyExitIds['tab-pty'] = true

      const binding = connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks7))
      )
      await flushAsyncTicks()
      expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')

      // Claim and latch mid-kill wakes before arming so generic resume cannot duplicate the session.
      const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-race'
      expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
      const claimedProviderSessions = new Set<string>()
      expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
      expect(claimedProviderSessions).toEqual(new Set([claimKey]))
      const connectCallsBeforeExit = transport.connect.mock.calls.length

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectWindowStartAskedMain(transport, paneKey)
        expect(transport.connect).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        return
      }
      // Arming consumed the latched wake — the --resume spawned with no reveal and no second wake event.
      expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
      const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
        | { command?: string }
        | undefined
      expect(resumeConnectOptions?.command).toContain('--resume')
      expect(resumeConnectOptions?.command).toContain('sess-hibernated-race')
    })

    it('keeps an in-place provider claim until the replacement PTY spawn settles', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      })
      const paneKey = `tab-1:${leafIdForPane(2)}`
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated-inflight' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(1),
          bindPaneAgentTitleMocks(deps, agentTitleMocks8)
        )
      )
      await flushAsyncTicks()

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()
      const deferredSpawn = createDeferred<unknown>()
      transport.connect.mockImplementationOnce(() => deferredSpawn.promise)

      const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-inflight'
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Claim while main starts, ask once, and leave record consumption to main.
        const layoutApply = await mainLayoutApplyTransport()
        layoutApply.answerWith('pending')
        const claim = 'wt-1\0claude\0session_id\0sess-hibernated-inflight'
        expect(binding.wakeHibernatedAgentIfArmed()).toBe(claim)
        expect(binding.wakeHibernatedAgentIfArmed()).toBe(claim)
        await flushAsyncTicks()
        expect(layoutApply.sentOfType('startPane')).toHaveLength(1)
        layoutApply.answerPending()
        await layoutApply.settle()
        await flushAsyncTicks()
        expectNoWindowStart(transport, mockStoreState)
        expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
        return
      }
      expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
      const connectCallsAfterFirstWake = transport.connect.mock.calls.length
      expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
      expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFirstWake)

      deferredSpawn.resolve('pty-resumed')
      await flushAsyncTicks()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        paneKey,
        origin: 'quit',
        restoreOnTabOpenOnly: true
      })
    })

    it('re-arms the exact hibernation target after a replacement spawn fails', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated-retry' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              consumeSuppressedPtyExit: vi.fn(() => true),
              isVisibleRef: { current: false }
            }),
            agentTitleMocks9
          )
        )
      )
      await flushAsyncTicks()

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()
      transport.connect.mockRejectedValueOnce(new Error('transient spawn failure'))

      const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-retry'
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main refuses the start: the wake re-arms, and the next wake asks main again.
        const layoutApply = await mainLayoutApplyTransport()
        layoutApply.answerWith({ refuse: 'pane_not_found' })
        const claim = 'wt-1\0claude\0session_id\0sess-hibernated-retry'
        expect(binding.wakeHibernatedAgentIfArmed()).toBe(claim)
        await layoutApply.settle()
        await flushAsyncTicks(20)
        expect(binding.wakeHibernatedAgentIfArmed()).toBe(claim)
        await layoutApply.settle()
        expect(layoutApply.sentOfType('startPane')).toHaveLength(2)
        expectNoWindowStart(transport, mockStoreState)
        return
      }
      expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
      await flushAsyncTicks(20)
      const connectCallsAfterFailure = transport.connect.mock.calls.length

      expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
      expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFailure + 1)
    })

    it('auto-resumes a hibernated pane when its kill lands after the pane is already revealed', async () => {
      // If reveal precedes wake arming, the arm-time visibility check must resume the pane immediately.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: true }
      })
      const pane = createPane(2)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: bindsPaneInStore(() => mockStoreState, 'tab-1', leafIdForPane(2))
        })
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated-2' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }

      const binding = connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks11))
      )
      await flushAsyncTicks()

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')
      // The deferred connect attached this transport to the persisted tab PTY, so the kill's exit must carry that id for the wake guard's same-pty check.
      expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
      const connectCallsBeforeExit = transport.connect.mock.calls.length
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectWindowStartAskedMain(transport, paneKey)
        expect(transport.connect).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        binding.noteVisibilityResume()
        await flushAsyncTicks()
        expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toHaveLength(1)
        return
      }
      expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
      const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
        | { command?: string }
        | undefined
      expect(resumeConnectOptions?.command).toContain('--resume')
      expect(resumeConnectOptions?.command).toContain('sess-hibernated-2')

      const connectCallsAfterWake = transport.connect.mock.calls.length
      binding.noteVisibilityResume()
      await flushAsyncTicks()
      expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
    })

    it('invalidates the hibernation wake when another flow rebinds the pane before reveal', async () => {
      // A hidden restart’s rebind permanently invalidates the old armed wake, including after a later PTY death.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      })
      const pane = createPane(2)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated-3' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }

      const binding = connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks12))
      )
      await flushAsyncTicks()

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')
      expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
      const connectCallsBeforeExit = transport.connect.mock.calls.length
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()

      // Another flow rebinds the pane to a fresh PTY while it is still hidden.
      transport.getPtyId.mockReturnValue('pty-restarted')
      binding.noteVisibilityResume()
      await flushAsyncTicks()
      // The rebound pane keeps its own session: no wake-driven resume spawn.
      expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

      // The rebound PTY later dies without a new sleeping record; the stale wake must not fire on the next reveal.
      transport.getPtyId.mockReturnValue(null)
      binding.noteVisibilityResume()
      await flushAsyncTicks()
      expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
    })
  })
}
