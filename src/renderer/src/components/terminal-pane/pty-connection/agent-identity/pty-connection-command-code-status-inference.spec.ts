import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { toAppSshPtyId } from '../../../../../../shared/ssh-pty-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
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

export function registerPtyConnectionCommandCodeStatusInferenceTests(): void {
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
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('seeds a working status for Command Code startup prompts after spawn', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const ptyId = 'pty-command-code'
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "command-code --trust 'Fix the status'",
          initialAgentStatus: { agent: 'command-code', prompt: 'Fix the status' }
        }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
      )
      await flushAsyncTicks()
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      onPtySpawn?.(ptyId)

      expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
        makePaneKey('tab-1', LEAF_1),
        {
          state: 'working',
          prompt: 'Fix the status',
          agentType: 'command-code',
          // Why: Orca launched this agent, so the seed predates any provider signal (STA-4293).
          observation: expect.objectContaining({ origin: 'launch', kind: 'transition' })
        },
        undefined,
        undefined,
        { connectionId: null }
      )
    })

    it('seeds a working status from Command Code thinking output without a startup prompt', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-command-code'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return ptyId
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
      capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

      expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
        makePaneKey('tab-1', LEAF_1),
        {
          state: 'working',
          prompt: 'Fix the spinner',
          agentType: 'command-code',
          // Why: read off the pane's own output, not a provider hook (STA-4293).
          observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
        },
        undefined,
        undefined,
        { connectionId: null }
      )
    })

    it('ignores delayed Command Code output after the leaf rebinds to another SSH host', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const oldPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
      const newPtyId = toAppSshPtyId('ssh-b', 'pty-command-code')
      const transport = createMockTransport(oldPtyId)
      transport.getConnectionId.mockReturnValue('ssh-a')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return oldPtyId
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState.repos = [{ id: 'repo1', connectionId: 'ssh-a' }]
      mockStoreState.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ startup: { command: 'command-code --trust' } }) as never,
          agentTitleMocks4
        )
      )
      await flushAsyncTicks()
      mockStoreState.setAgentStatus.mockClear()
      mockStoreState.ptyIdsByTabId = { 'tab-1': [oldPtyId, newPtyId] }
      mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: newPtyId }

      capturedDataCallback.current?.('❯ stale prompt\r\n\x1b[35m✻ Thinking...\x1b[0m')

      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    })

    it('marks a Command Code no-tool turn done after the idle prompt settles', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )
      vi.runOnlyPendingTimers()
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('❯ say hi\r\n✻ Thinking...')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })

      capturedDataCallback.current?.(
        '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
      )
      vi.advanceTimersByTime(1499)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })

      vi.advanceTimersByTime(1)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        prompt: 'say hi',
        agentType: 'command-code'
      })
    })

    it('keeps Command Code working when an active repaint follows the idle prompt before settle', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )
      vi.runOnlyPendingTimers()
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('❯ Run a slow command\r\n✻ Thinking...')
      capturedDataCallback.current?.('\r\n❯ Ask your question...')
      vi.advanceTimersByTime(1000)
      capturedDataCallback.current?.('\r\n✧ Investigating... esc to interrupt')
      vi.advanceTimersByTime(500)

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'Run a slow command',
        agentType: 'command-code'
      })
    })

    it('does not downgrade a completed Command Code turn back to working from stale TUI output', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks7)
      )
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
      capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Threading...\x1b[0m')

      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
      expect((mockStoreState.agentStatusByPaneKey[paneKey] as { state?: unknown })?.state).toBe(
        'done'
      )
    })

    it('starts a new Command Code turn after done when TUI output carries a different prompt', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'done',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        stateHistory: []
      }

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
      capturedDataCallback.current?.('❯ Fix the green done state\r\n\x1b[35m✻ Threading...\x1b[0m')

      expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
        paneKey,
        {
          state: 'working',
          prompt: 'Fix the green done state',
          agentType: 'command-code',
          observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
        },
        undefined,
        undefined,
        { connectionId: null }
      )
    })
  })
}
