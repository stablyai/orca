import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_GRAPHIC_RENDITION } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  terminalWriteText,
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

export function registerPtyConnectionDeferredReattachLiveOutputTests(): void {
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

    it.each([
      { kind: 'covered backlog', snapshot: 'startup\r\n', seq: 9, count: 1 },
      { kind: 'legacy unsequenced snapshot', snapshot: 'startup\r\n', seq: undefined, count: 2 },
      { kind: 'blank snapshot', snapshot: '\x1b[2J', seq: 9, count: 1 }
    ])(
      'preserves output while reconciling $kind on daemon adoption',
      async ({ snapshot, seq, count }) => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('tab-pty')
        transport.connect.mockImplementation(
          async ({
            sessionId,
            callbacks
          }: {
            sessionId?: string
            callbacks?: ConnectCallbacks
          }) => {
            callbacks?.onData?.('startup\r\n', { seq: 9, rawLength: 9 })
            callbacks?.onData?.('new output\r\n', { seq: 21, rawLength: 12 })
            return { id: sessionId, snapshot, snapshotSeq: seq }
          }
        )
        transportFactoryQueue.push(transport)
        const pane = createPane(1)
        const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
        const deps = createDeps({
          isVisibleRef: { current: true },
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
        })
        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
        )
        await flushAsyncTicks(20)
        for (let step = 0; step < 40; step += 1) {
          parseCallbacks.shift()?.()
          await flushAsyncTicks(2)
        }
        expect(writes.join('').match(/startup/g)).toHaveLength(count)
        expect(writes.join('')).toContain('new output')
      }
    )

    it('drains live bytes after transport confirms an explicit reattach', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { deliverTerminalDataWithDeferredCredit } =
        await import('@/lib/pane-manager/terminal-delivery-credit')
      const transport = createMockTransport('tab-pty')
      const acknowledgeLiveFrame = vi.fn()
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (!sessionId) {
            return null
          }
          // Why: the real dispatcher drains post-snapshot bytes as soon as spawn IPC resolves, before connect() returns.
          callbacks?.onReattachDetermined?.()
          deliverTerminalDataWithDeferredCredit(acknowledgeLiveFrame, () => {
            callbacks?.onData?.('post-snapshot-live')
          })
          return { id: sessionId, snapshot: 'authoritative-snapshot' }
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(
        pane as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
      )
      await flushAsyncTicks(20)

      const snapshotIndex = writes.indexOf(`${RESET_GRAPHIC_RENDITION}authoritative-snapshot`)
      expect(snapshotIndex).toBeGreaterThanOrEqual(0)
      expect(writes).not.toContain('post-snapshot-live')
      for (let step = 0; step < 40; step += 1) {
        parseCallbacks.shift()?.()
        await flushAsyncTicks(2)
      }
      const liveIndex = writes.indexOf('post-snapshot-live')
      expect(liveIndex).toBeGreaterThan(snapshotIndex)
      expect(acknowledgeLiveFrame).toHaveBeenCalledOnce()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'tab-pty')
    })

    it('does not steal a newer user pin while deferred reattach output settles', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { markTerminalFollowOutput, markTerminalPinnedViewport } =
        await import('@/lib/pane-manager/terminal-scroll-intent')
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (!sessionId) {
            return null
          }
          callbacks?.onData?.('post-snapshot-live')
          return { id: sessionId, snapshot: 'authoritative-snapshot' }
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      pane.terminal.buffer.active.baseY = 100
      pane.terminal.buffer.active.viewportY = 100
      markTerminalFollowOutput(pane.terminal)
      const parseCallbacks: { data: string; run: () => void }[] = []
      pane.terminal.write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
        data = terminalWriteText(data)
        parseCallbacks.push({
          data,
          run: () => {
            if (data === 'post-snapshot-live') {
              pane.terminal.buffer.active.baseY = 200
              pane.terminal.buffer.active.viewportY = 100
            }
            callback?.()
          }
        })
      })
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(
        pane as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )
      await flushAsyncTicks(20)
      for (let index = 0; index < 40; index += 1) {
        const pending = parseCallbacks.shift()
        pending?.run()
        await flushAsyncTicks(4)
        if (pending?.data === 'post-snapshot-live') {
          pane.terminal.buffer.active.viewportY = 150
          markTerminalPinnedViewport(pane.terminal)
        }
        if (parseCallbacks.length === 0 && index > 8) {
          break
        }
      }

      expect(pane.terminal.buffer.active.viewportY).toBe(150)
    })

    it('does not fresh-spawn after a dead deferred session delivers its buffered exit', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (!sessionId) {
            return 'unexpected-fresh-pty'
          }
          callbacks?.onData?.('dead-session-final-frame')
          return { id: sessionId, exitedBeforeAttach: true }
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const { writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(
        pane as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(writes).toContain('dead-session-final-frame')
      expect(deps.updateTabPtyId).not.toHaveBeenCalled()
    })
  })
}
