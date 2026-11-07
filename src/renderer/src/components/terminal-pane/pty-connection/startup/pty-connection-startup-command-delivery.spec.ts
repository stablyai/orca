import {
  TERMINAL_PASTE_CHUNK_MAX_BYTES,
  TERMINAL_PASTE_DIRECT_MAX_BYTES
} from '../../input/paste/terminal-paste-limits'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
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
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionLocalStartupCommandDeliveryTests(): void {
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

    it('does not send startup command via sendInput for local connections', async () => {
      // Why: the local PTY provider already writes the command via writeStartupCommandWhenShellReady; re-sending from the renderer would double it in the terminal.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport()
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ startup: { command: "claude 'say test'" } })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('(base) user@host $ ')

      expect(transport.sendInput).not.toHaveBeenCalledWith(
        expect.stringContaining("claude 'say test'")
      )
    })
  })
}

export function registerPtyConnectionTerminalPasteStartupCommandDeliveryTests(): void {
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

    it('chunks large terminal-paste startup commands through the PTY before submitting', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
        loopLimit: 100
      })
      const scheduledTimeouts = vi.spyOn(globalThis, 'setTimeout')

      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks9 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        const transport = createMockTransport('pty-id')
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-local-paste'
          }
        )
        transportFactoryQueue.push(transport)

        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
          repos: [{ id: 'repo1', connectionId: null }]
        }

        const pane = createPane(1)
        pane.terminal.write.mockImplementation(
          (_data: string | Uint8Array, callback?: () => void) => {
            callback?.()
          }
        )
        const manager = createManager(1)
        const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
        const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
        )
        expect(createdTransportOptions[0]?.command).toBeUndefined()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('user@host $ ')
        await vi.advanceTimersByTimeAsync(100)
        await flushAsyncTicks()
        expect(scheduledTimeouts.mock.calls.length).toBeLessThanOrEqual(100)

        const writtenInput = transport.sendInput.mock.calls.map((call) => call[0])
        expect(pane.terminal.paste).not.toHaveBeenCalled()
        expect(writtenInput.at(-1)).toBe('\r')
        expect(writtenInput.slice(0, -1).join('')).toBe(command)
        expect(writtenInput.slice(0, -1).length).toBeGreaterThan(1)
        expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
      } finally {
        vi.restoreAllMocks()
        vi.useRealTimers()
      }
    })

    it('does not submit a terminal-paste startup command after the PTY changes mid-paste', async () => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
        loopLimit: 100
      })
      const scheduledTimeouts = vi.spyOn(globalThis, 'setTimeout')

      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks10 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        const transport = createMockTransport('pty-id')
        let livePtyId = 'pty-local-paste'
        let ptyIdBeforeReplacement: string | null = null
        transport.getPtyId.mockImplementation(() => livePtyId)
        transport.sendInput.mockImplementation((data: string) => {
          if (data !== '\r') {
            ptyIdBeforeReplacement = livePtyId
            livePtyId = 'pty-replaced'
          }
          return true
        })
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-local-paste'
          }
        )
        transportFactoryQueue.push(transport)

        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
          repos: [{ id: 'repo1', connectionId: null }]
        }

        const pane = createPane(1)
        pane.terminal.write.mockImplementation(
          (_data: string | Uint8Array, callback?: () => void) => {
            callback?.()
          }
        )
        const manager = createManager(1)
        const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
        const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks10)
        )
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('user@host $ ')
        await vi.advanceTimersByTimeAsync(100)
        await flushAsyncTicks()
        expect(scheduledTimeouts.mock.calls.length).toBeLessThanOrEqual(100)

        expect(pane.terminal.paste).not.toHaveBeenCalled()
        expect(transport.sendInput).not.toHaveBeenCalledWith('\r')
        expect(ptyIdBeforeReplacement).toBe('pty-local-paste')
        expect(transport.sendInput.mock.calls.map((call) => call[0])).toEqual([
          'x'.repeat(TERMINAL_PASTE_CHUNK_MAX_BYTES)
        ])
        expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).not.toBe(command)
      } finally {
        vi.restoreAllMocks()
        vi.useRealTimers()
      }
    })
  })
}
