import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectNoWindowStart,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from './pty-connection-test-main-pane-start-fixtures'
import {
  LEAF_2,
  leafIdForPane,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('disarms input modes and resumes a hibernated agent session on visibility reveal', async () => {
      // Regression: hibernation suppresses its kill's PTY exit while hidden; before the wake fix onExit permanently latched handledExitPtyId, leaving a frozen inert ghost pane on reveal.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      // Hibernation only targets hidden panes, so the exit lands while not visible and the wake must wait for the reveal.
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
        providerSession: { key: 'session_id', id: 'sess-hibernated-1' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      mockStoreState.suppressedPtyExitIds['tab-pty'] = true

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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

      // The frozen frame's input-eating modes are disarmed at hibernation-exit (mouse tracking / bracketed paste would otherwise swallow clicks).
      const writesAfterExit = pane.terminal.write.mock.calls.flat().join('')
      expect(writesAfterExit).toContain('\x1b[?1003l')
      expect(writesAfterExit).toContain('\x1b[?2004l')
      // A hidden pane must not respawn on exit — the wake waits for the reveal.
      expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // The wake asks main to start the pane; the window attaches to what main binds.
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
      expect(resumeConnectOptions?.command).toContain('sess-hibernated-1')

      const connectCallsAfterWake = transport.connect.mock.calls.length
      binding.noteVisibilityResume()
      await flushAsyncTicks()
      expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
    })

    // A suppressed exit over a finished turn’s live anchor still arms reveal resume despite its worktree-sleep note (#16308).
    it('arms an in-place resume from a finished turn idle anchor on a suppressed exit', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
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
        providerSession: { key: 'session_id', id: 'sess-idle-anchor' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
      mockStoreState.suppressedPtyExitIds['tab-pty'] = true
      const args = mockPanePtyArgs(pane, createManager(1), deps)
      const binding = connectPanePty(...args)
      await flushAsyncTicks()
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      expect(onPtyExit).toBeTypeOf('function')
      const connectCallsBeforeExit = transport.connect.mock.calls.length
      if (typeof onPtyExit === 'function') {
        onPtyExit('tab-pty')
      }
      await flushAsyncTicks()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectWindowStartAskedMain(transport, paneKey)
        expect(transport.connect).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        return
      }
      const resumeConnectOptions: { command?: string } | undefined =
        transport.connect.mock.calls.at(-1)?.[0]
      expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
      expect(resumeConnectOptions?.command).toContain('sess-idle-anchor')
    })

    it('resumes a hibernated agent from a navigation-free wake without a visibility reveal', async () => {
      // Mobile wakes hidden panes without visibility changes; duplicate wake events must resume exactly once (INV-1).
      const { connectPanePty } = await import('./pty-connection')
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
        providerSession: { key: 'session_id', id: 'sess-hibernated-bg' },
        prompt: 'test prompt',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep'
      }
      mockStoreState.suppressedPtyExitIds['tab-pty'] = true

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
      const connectCallsBeforeExit = transport.connect.mock.calls.length
      onPtyExit?.('tab-pty')
      await flushAsyncTicks()
      // Still hidden: no reveal happened, so nothing respawned on exit.
      expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

      // The wake reports the claim it consumed so the dispatcher's generic resume never launches the same provider session into a second tab.
      const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-bg'
      expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
      expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
      const claimedProviderSessions = new Set<string>()
      expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
      expect(claimedProviderSessions).toEqual(new Set([claimKey]))
      await flushAsyncTicks()

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectWindowStartAskedMain(transport, paneKey)
        expect(transport.connect).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        binding.wakeHibernatedAgentIfArmed()
        await flushAsyncTicks()
        expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toHaveLength(1)
        return
      }
      expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
      const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
        | { command?: string }
        | undefined
      expect(resumeConnectOptions?.command).toContain('--resume')
      expect(resumeConnectOptions?.command).toContain('sess-hibernated-bg')

      const connectCallsAfterWake = transport.connect.mock.calls.length
      binding.wakeHibernatedAgentIfArmed()
      await flushAsyncTicks()
      expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
    })

    it('names the replaced PTY on the restart spawn only, never on a later wake of the same pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      binding.dispose()
      await flushAsyncTicks()
      expect(window.api.pty.kill).not.toHaveBeenCalledWith('pty-replaced')
    })

    it('keeps an established split pane mounted when main labels its exit as a restart replacement', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { deliverPtyExitToHandlers } = await import('./pty-exit-delivery')
      let onData: ((data: string) => void) | undefined
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          onData = callbacks.onData
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const args = mockPanePtyArgs(createPane(2), manager, deps)
      connectPanePty(...args)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      expect(onPtyExit).toBeTypeOf('function')
      await flushAsyncTicks()
      onData?.('codex prompt')

      deliverPtyExitToHandlers({
        ptyId: 'pty-pane-2',
        code: 0,
        replacedByRestart: true,
        primary: (code) => {
          if (typeof onPtyExit === 'function') {
            onPtyExit('pty-pane-2', code)
          }
        },
        sidecars: []
      })

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    })

    it('stops the replaced PTY itself when the pane is disposed before a spawn carried the stop', async () => {
      const { connectPanePty } = await import('./pty-connection')
      transportFactoryQueue.push(createMockTransport('pty-restarted'))
      const deps = createDeps({
        tabId: 'tab-restart-closed',
        startup: { command: 'codex', launchAgent: 'codex' },
        replacesPtyId: 'pty-replaced'
      })
      const args = mockPanePtyArgs(createPane(2), createManager(1), deps)
      // Closing the tab (or parking it) disposes the pane before its deferred connect runs.
      connectPanePty(...args).dispose()
      await flushAsyncTicks()

      expect(window.api.pty.kill).toHaveBeenCalledWith('pty-replaced')
    })

    it('latches a navigation-free wake that lands before the hibernation kill arms the pane', async () => {
      // Latch wake events between recording sleep and arming the kill’s PTY ID, or the frozen pane remains stranded (#7906).
      const { connectPanePty } = await import('./pty-connection')
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

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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
      const { connectPanePty } = await import('./pty-connection')
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
      const binding = connectPanePty(...mockPanePtyArgs(createPane(2), createManager(1), deps))
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
      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    })

    it('re-arms the exact hibernation target after a replacement spawn fails', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
          createDeps({
            consumeSuppressedPtyExit: vi.fn(() => true),
            isVisibleRef: { current: false }
          })
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

    it('does not latch a stale sleeping record beside an unsuppressed live PTY', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const paneKey = `tab-1:${leafIdForPane(2)}`
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-stale' },
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
          createDeps({ isVisibleRef: { current: false } })
        )
      )
      await flushAsyncTicks()

      expect(binding.wakeHibernatedAgentIfArmed()).toBeNull()
    })

    it('auto-resumes a hibernated pane when its kill lands after the pane is already revealed', async () => {
      // If reveal precedes wake arming, the arm-time visibility check must resume the pane immediately.
      const { connectPanePty } = await import('./pty-connection')
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

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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
      const { connectPanePty } = await import('./pty-connection')
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

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
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

    it('records hibernation activity from the core user-input signal, not synthetic onData replies', async () => {
      // Regression: xterm auto-replies share the onData stream with typing; recording them as input made the planner see "input after done" and never hibernate.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(2)
      const userInputListeners = new Set<() => void>()
      ;(pane.terminal as unknown as { _core: unknown })._core = {
        coreService: {
          onUserInput: vi.fn((listener: () => void) => {
            userInputListeners.add(listener)
            return { dispose: () => userInputListeners.delete(listener) }
          })
        }
      }

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      expect(userInputListeners.size).toBeGreaterThan(0)
      ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

      // A focus-out report forwarded to the PTY must not count as activity.
      sendTerminalInputThroughPane(pane, '\x1b[O')
      expect(mockStoreState.recordTerminalInput).not.toHaveBeenCalled()
      // The reply still reaches the shell; only the activity recording is gated.
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O', 'query-reply')

      // Real user input fires the core signal and records activity.
      for (const listener of userInputListeners) {
        listener()
      }
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)

      binding.dispose()
      expect(userInputListeners.size).toBe(0)
    })

    it('falls back to onData hibernation recording when the core user-input signal is unavailable', async () => {
      // If an xterm upgrade removes the internal signal, activity recording must degrade to the historical onData behavior — never to no tracking at all.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(2)

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await flushAsyncTicks()
      ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

      sendTerminalInputThroughPane(pane, 'x')
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)
    })
  })
}
