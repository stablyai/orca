import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import { createKeyboardEventTarget, keyEvent } from '../test-fixtures/pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionCommandFinishedInterruptArbitrationTests(): void {
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

    it.each(['gemini', 'codex'] as const)(
      'pins %s interrupt policy before acknowledged input and command exit cleanup',
      async (agentType) => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks14 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        const transport = createMockTransport()
        const writeAccepted = createDeferred<boolean>()
        transport.sendInputAccepted = vi.fn(() => writeAccepted.promise)
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return { id: 'tab-pty' }
          }
        )
        transport.attach.mockImplementation(({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
        })
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        vi.setSystemTime(1_100)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState = {
          ...mockStoreState,
          agentStatusByPaneKey: {
            [paneKey]: {
              paneKey,
              state: 'working',
              prompt: 'stop quickly',
              updatedAt: 1_000,
              stateStartedAt: 900,
              agentType,
              terminalTitle: agentType,
              stateHistory: []
            }
          }
        }
        vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
          mockStoreState.agentStatusByPaneKey[paneKey] = {
            paneKey,
            state: 'done',
            prompt: 'stop quickly',
            updatedAt: 1_100,
            stateStartedAt: 1_100,
            agentType,
            terminalTitle: agentType,
            interrupted: true,
            stateHistory: [
              {
                state: 'working',
                prompt: 'stop quickly',
                startedAt: 900
              }
            ]
          }
          return true
        })
        const terminalTarget = createKeyboardEventTarget()
        const pane = createPane(1)
        ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
        let onDataHandler: ((data: string) => void) | null = null
        pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
          onDataHandler = handler
          return { dispose: vi.fn() }
        }) as typeof pane.terminal.onData)

        connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps(), agentTitleMocks14)
          )
        )
        vi.advanceTimersByTime(1_000)
        await flushAsyncTicks()
        expect(capturedDataCallback.current).not.toBeNull()
        if (!onDataHandler) {
          throw new Error('expected onData handler to be registered')
        }
        terminalTarget.dispatch(keyEvent({ key: 'Escape' }))
        ;(onDataHandler as unknown as (data: string) => void)('\x1b')

        capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
        expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

        delete mockStoreState.agentStatusByPaneKey[paneKey]
        writeAccepted.resolve(true)
        await flushAsyncTicks()

        if (agentType === 'codex') {
          expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
          expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
          expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
        } else {
          expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
            paneKey,
            baselineUpdatedAt: 1_000,
            baselineStateStartedAt: 900,
            baselinePrompt: 'stop quickly',
            baselineAgentType: agentType,
            intent: 'plain-escape'
          })
          expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
        }
      }
    )

    it('drops the command-finished status when pending interrupt inference is rejected', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks15 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

      vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(false)
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport()
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return { id: 'tab-pty' }
        }
      )
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()
      vi.setSystemTime(1_100)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'stop quickly',
            updatedAt: 1_000,
            stateStartedAt: 900,
            agentType: 'custom-agent',
            terminalTitle: 'Codex',
            stateHistory: []
          }
        }
      }
      const terminalTarget = createKeyboardEventTarget()
      const pane = createPane(1)
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks15)
        )
      )
      vi.advanceTimersByTime(1_000)
      await flushAsyncTicks()
      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')

      capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
      await flushAsyncTicks()

      expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
      expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    })
  })
}
