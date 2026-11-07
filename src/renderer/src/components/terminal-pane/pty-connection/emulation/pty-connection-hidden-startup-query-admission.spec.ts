import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
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
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionHiddenStartupQueryAdmissionTests(): void {
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

    it('keeps hidden Codex telemetry startup output parsing briefly', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: {
                command: 'wrapped-agent',
                telemetry: {
                  agent_kind: 'codex',
                  launch_source: 'tab_bar_quick_launch',
                  request_kind: 'new'
                }
              }
            }),
            agentTitleMocks10
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        '\x1b]11;?\x1b\\startup frame\r\n',
        expect.any(Function)
      )

      binding.dispose()
    })

    it('does not answer hidden Jcode startup color queries (composer-text leak guard)', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: {
                command: 'jcode',
                launchAgent: 'jcode',
                telemetry: {
                  agent_kind: 'jcode',
                  launch_source: 'tab_bar_quick_launch',
                  request_kind: 'new'
                }
              }
            }),
            agentTitleMocks11
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b]10;?\x1b\\\x1b]11;?\x1b\\startup frame\r\n')

      const replies = transport.sendInput.mock.calls.map(([data]) => data).join('')
      expect(replies).not.toContain('\x1b]10;rgb:')
      expect(replies).not.toContain('\x1b]11;rgb:')

      binding.dispose()
    })

    it('keeps hidden Grok telemetry startup output parsing briefly', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: {
                command: 'wrapped-agent',
                telemetry: {
                  agent_kind: 'grok',
                  launch_source: 'tab_bar_quick_launch',
                  request_kind: 'new'
                }
              }
            }),
            agentTitleMocks12
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        '\x1b]11;?\x1b\\startup frame\r\n',
        expect.any(Function)
      )

      binding.dispose()
    })

    it('keeps hidden bare Codex startup commands parsing briefly', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks13
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        '\x1b]11;?\x1b\\startup frame\r\n',
        expect.any(Function)
      )

      binding.dispose()
    })

    it('keeps hidden bare Grok startup commands parsing briefly', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks14 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: '/Users/me/.grok/bin/grok --permission-mode bypassPermissions' }
            }),
            agentTitleMocks14
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        '\x1b]11;?\x1b\\startup frame\r\n',
        expect.any(Function)
      )

      binding.dispose()
    })

    it('skips arbitrary hidden startup output parsing', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks15 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'printf noisy startup' }
            }),
            agentTitleMocks15
          )
        )
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('hidden startup output\r\n')

      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'hidden startup output\r\n',
        expect.any(Function)
      )

      binding.dispose()
    })
  })
}
