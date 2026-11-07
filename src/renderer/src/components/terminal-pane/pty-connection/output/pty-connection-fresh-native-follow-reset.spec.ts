import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import {
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

export function registerPtyConnectionFreshNativeFollowResetTests(): void {
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

    it('retries a fresh-spawn native follow reset when renderer dimensions return', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { getTerminalScrollIntentKind } =
        await import('@/lib/pane-manager/terminal-scroll-intent')
      const transport = createMockTransport('fresh-pty')
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
      } as StoreState
      const pane = createPane(1)
      pane.terminal.buffer.active.viewportY = 40
      pane.terminal.buffer.active.baseY = 100
      const renderListener: { current: (() => void) | null } = { current: null }
      const renderDisposable = { dispose: vi.fn() }
      pane.terminal.onRender = vi.fn((listener: () => void) => {
        renderListener.current = listener
        return renderDisposable
      })
      vi.mocked(pane.terminal.scrollToBottom)
        .mockImplementationOnce(() => {
          throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
        })
        .mockImplementation(() => {
          pane.terminal.buffer.active.viewportY = pane.terminal.buffer.active.baseY
        })

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks)
        )
      )
      await flushAsyncTicks()
      expect(pane.terminal.buffer.active.viewportY).toBe(40)
      expect(renderListener.current).not.toBeNull()

      renderListener.current?.()
      expect(pane.terminal.buffer.active.viewportY).toBe(100)
      expect(pane.terminal.scrollToBottom).toHaveBeenCalledTimes(2)
      expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
      expect(renderDisposable.dispose).toHaveBeenCalledTimes(1)
    })
  })
}
