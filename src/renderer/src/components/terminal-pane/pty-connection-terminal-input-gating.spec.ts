import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createKeyboardEventTarget,
  keyEvent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
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

/** What remountTerminalTabForRecovery answers now that it reports admission. */
const REMOUNTED = { remounted: true as const, generation: 1 }
const AUTOMATIC_REQUEST = expect.objectContaining({ trigger: 'automatic' })

export function registerPtyConnectionTerminalInputGatingTests(): void {
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
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('does not infer interrupts when mobile presence lock blocks terminal input', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

      vi.useFakeTimers()
      vi.setSystemTime(1_100)
      const ptyId = 'pty-mobile-locked'
      setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
      try {
        const transport = createMockTransport(ptyId)
        transportFactoryQueue.push(transport)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
          ptyIdsByTabId: { 'tab-1': [ptyId] },
          agentStatusByPaneKey: {
            [paneKey]: {
              paneKey,
              state: 'working',
              prompt: 'locked input',
              updatedAt: 1_000,
              stateStartedAt: 900,
              agentType: 'codex',
              stateHistory: []
            }
          }
        }

        const pane = createPane(1)
        const terminalTarget = createKeyboardEventTarget()
        ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
        let onDataHandler: ((data: string) => void) | null = null
        pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
          onDataHandler = handler
          return { dispose: vi.fn() }
        }) as typeof pane.terminal.onData)

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

        if (!onDataHandler) {
          throw new Error('expected onData handler to be registered')
        }
        terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
        ;(onDataHandler as unknown as (data: string) => void)('\x03')
        ;(onDataHandler as unknown as (data: string) => void)('x')
        vi.advanceTimersByTime(500)

        expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
        expect(transport.sendInput).not.toHaveBeenCalled()
        expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
      } finally {
        setDriverForPty(ptyId, { kind: 'idle' })
      }
    })

    it('drops xterm protocol replies from live TUI output while mobile presence lock is active', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

      const ptyId = 'pty-mobile-tui-query'
      setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
      try {
        const transport = createMockTransport(ptyId)
        transportFactoryQueue.push(transport)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
          ptyIdsByTabId: { 'tab-1': [ptyId] }
        }

        const pane = createPane(1)
        let onDataHandler: ((data: string) => void) | null = null
        pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
          onDataHandler = handler
          return { dispose: vi.fn() }
        }) as typeof pane.terminal.onData)

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

        if (!onDataHandler) {
          throw new Error('expected onData handler to be registered')
        }
        // Simulate xterm answering a TUI's DA1 query while the phone owns the PTY.
        ;(onDataHandler as unknown as (data: string) => void)('\x1b[?1;2c')
        // Capability handlers are registered outside onData and must honor the same mobile query-authority lock.
        const csiCalls = (
          pane.terminal.parser.registerCsiHandler as unknown as {
            mock: { calls: [{ final: string }, (params: (number | number[])[]) => boolean][] }
          }
        ).mock.calls
        const da1Handler = csiCalls.find(([id]) => id.final === 'c')?.[1]
        expect(da1Handler).toBeTypeOf('function')
        da1Handler?.([])
        await flushAsyncTicks()

        expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
        expect(transport.sendInput).not.toHaveBeenCalled()
        expect(transport.sendInputImmediate).not.toHaveBeenCalled()
      } finally {
        setDriverForPty(ptyId, { kind: 'idle' })
      }
    })

    it('blocks remote locked terminal input before it reaches the runtime transport', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

      const ptyId = 'remote:env-1@@terminal-1'
      setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
      try {
        const transport = createMockTransport(ptyId)
        transportFactoryQueue.push(transport)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
          ptyIdsByTabId: { 'tab-1': [ptyId] }
        }

        const pane = createPane(1)
        let onDataHandler: ((data: string) => void) | null = null
        pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
          onDataHandler = handler
          return { dispose: vi.fn() }
        }) as typeof pane.terminal.onData)

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

        if (!onDataHandler) {
          throw new Error('expected onData handler to be registered')
        }
        ;(onDataHandler as unknown as (data: string) => void)('x')
        await flushAsyncTicks()

        expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
        expect(transport.sendInput).not.toHaveBeenCalled()
      } finally {
        setDriverForPty(ptyId, { kind: 'idle' })
      }
    })

    it('does not infer interrupts when the transport rejects terminal input', async () => {
      const { connectPanePty } = await import('./pty-connection')

      vi.useFakeTimers()
      vi.setSystemTime(1_100)
      const transport = createMockTransport('pty-disconnected')
      transport.sendInput.mockReturnValue(false)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'working',
        prompt: 'disconnected input',
        updatedAt: 1_000,
        stateStartedAt: 900,
        agentType: 'custom-agent',
        stateHistory: []
      }

      const pane = createPane(1)
      const terminalTarget = createKeyboardEventTarget()
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')
      await flushAsyncTicks()
      await vi.advanceTimersByTimeAsync(500)
      await flushAsyncTicks()

      expect(transport.sendInput).toHaveBeenCalledWith('\x03')
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    })

    it('does not infer interrupts when the main process rejects acknowledged input', async () => {
      const { connectPanePty } = await import('./pty-connection')

      vi.useFakeTimers()
      vi.setSystemTime(1_100)
      const transport = createMockTransport('pty-mobile-race')
      transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'working',
        prompt: 'mobile race input',
        updatedAt: 1_000,
        stateStartedAt: 900,
        agentType: 'custom-agent',
        stateHistory: []
      }

      const pane = createPane(1)
      const terminalTarget = createKeyboardEventTarget()
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')
      await flushAsyncTicks()
      await vi.advanceTimersByTimeAsync(500)
      await flushAsyncTicks()

      expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03', 'query-reply')
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    })

    it('remounts a connected pane when main reports its daemon write unavailable', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
      _resetTerminalPaneRecoveryForTests()
      const remountTerminalTabForRecovery = vi.fn(() => REMOUNTED)
      mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
      const transport = createMockTransport('daemon-pty')
      let writeUnavailable: (() => void) | undefined
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          writeUnavailable = callbacks.onWriteUnavailable
          return { id: 'daemon-pty' }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      writeUnavailable?.()
      await flushAsyncTicks(6)

      expect(window.api.pty.hasPty).toHaveBeenCalledWith('daemon-pty')
      expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1', AUTOMATIC_REQUEST)
      _resetTerminalPaneRecoveryForTests()
    })

    it('quarantines the interrupted line after a write-unavailable remount, but never device replies', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
      _resetTerminalPaneRecoveryForTests()
      const remountTerminalTabForRecovery = vi.fn(() => REMOUNTED)
      mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
      const transport = createMockTransport('daemon-pty')
      let writeUnavailable: (() => void) | undefined
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          writeUnavailable = callbacks.onWriteUnavailable
          return { id: 'daemon-pty' }
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      writeUnavailable?.()
      await flushAsyncTicks(6)
      expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1', AUTOMATIC_REQUEST)

      // The surviving tail of `echo hi; rm -rf x`: reaching the fresh shell would
      // let the user's own Enter run `rm -rf x` (#10065 follow-up).
      sendTerminalInputThroughPane(pane, 'cho hi; rm -rf x')
      expect(transport.sendInput.mock.calls.map(([data]) => data)).not.toContain('cho hi; rm -rf x')
      // A program that queries during reattach hangs if its reply is dropped.
      sendTerminalInputThroughPane(pane, '\x1b[3;1R')
      expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[3;1R')
      sendTerminalInputThroughPane(pane, '\r')
      expect(transport.sendInput.mock.calls.map(([data]) => data)).not.toContain('\r')
      // The terminator disarmed it, so the next real command reaches the shell.
      sendTerminalInputThroughPane(pane, 'ls\r')
      expect(transport.sendInput).toHaveBeenCalledWith('ls\r', 'query-reply')
      _resetTerminalPaneRecoveryForTests()
    })

    it('recovers a wedged write pipeline after accepted input without renderer output', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const { settleTerminalWriteStallWatch, WRITE_PIPELINE_STALL_CHECK_MS } =
        await import('@/lib/pane-manager/terminal-write-pipeline-health')
      const remountTerminalTabForRecovery = vi.fn(() => REMOUNTED)
      mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
      const transport = createMockTransport('pty-wedged')
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const binding = connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks()
      pane.terminal.write.mockClear()
      pane.terminal.write.mockImplementation(() => {})

      sendTerminalInputThroughPane(pane, 'x')
      settleTerminalWriteStallWatch(pane.terminal)
      vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)
      await flushAsyncTicks()

      expect(transport.sendInput).toHaveBeenCalledWith('x', 'query-reply')
      expect(pane.terminal.write).toHaveBeenCalledWith('', expect.any(Function))
      expect(remountTerminalTabForRecovery).toHaveBeenCalledWith('tab-1', AUTOMATIC_REQUEST)
      binding.dispose()
    })

    it('does not arm the wedge probe when acknowledged input is rejected', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const { WRITE_PIPELINE_STALL_CHECK_MS } =
        await import('@/lib/pane-manager/terminal-write-pipeline-health')
      const transport = createMockTransport('pty-rejected')
      transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const binding = connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks()
      pane.terminal.write.mockClear()
      pane.terminal.write.mockImplementation(() => {})

      sendTerminalInputThroughPane(pane, '\x03')
      await flushAsyncTicks()
      vi.advanceTimersByTime(WRITE_PIPELINE_STALL_CHECK_MS * 2)
      await flushAsyncTicks()

      expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03', 'query-reply')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('', expect.any(Function))
      binding.dispose()
    })
  })
}
