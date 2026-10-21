import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { createRect } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

export function registerPtyConnectionParkRevealModelSnapshotTests(): void {
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

    it('restores configured paired scrollback after an ordinary park reveal', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const remotePtyId = 'remote:env-1@@terminal-1'
      const transport = createMockTransport(remotePtyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          transport.getPtyId.mockReturnValue(remotePtyId)
          callbacks.onReplayData?.('current screen from initial subscribe\r\n')
          return { id: remotePtyId, isReattach: true, replay: '' }
        }
      )
      transport.serializeBuffer = vi.fn().mockResolvedValue({
        data: 'DEEP_PAIRED_SCROLLBACK\r\ncurrent screen\r\n',
        cols: 100,
        rows: 30,
        seq: 4_096,
        source: 'headless'
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        runtimeStatusByEnvironmentId: new Map([
          [
            'env-1',
            {
              checkedAt: Date.now(),
              status: { capabilities: ['terminal.paired-parking.v1'] }
            }
          ]
        ])
      }

      const pane = createPane(1)
      const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({ mountFollowsTerminalPark: true })

      connectPanePty(pane as never, createManager(1) as never, deps as never)
      for (let step = 0; step < 30; step += 1) {
        parseCallbacks.shift()?.()
        await flushAsyncTicks(2)
      }

      expect(transport.serializeBuffer).toHaveBeenCalledWith({
        scrollbackRows: 5000,
        repaintsPane: true
      })
      expect(transport.attach).not.toHaveBeenCalled()
      expect(writes.join('')).toContain('DEEP_PAIRED_SCROLLBACK')
      expect(writes.join('')).toContain('current screen from initial subscribe')
      expect(transport.getPtyId).toHaveReturnedWith(remotePtyId)
    })

    it('keeps a parked main-model alt frame at its capture grid while hidden', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const localPtyId = 'global-floating-terminal@@terminal-1'
      const transport = createMockTransport(localPtyId)
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        transport.getPtyId.mockReturnValue(localPtyId)
        return sessionId ? { id: localPtyId, isReattach: true } : null
      })
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
      getMainBufferSnapshot.mockResolvedValue({
        data: 'FLOATING-PARK-ALT-FRAME',
        frameRestoreAnsi: '\x1b[?25l',
        cols: 113,
        rows: 32,
        seq: 558,
        source: 'headless',
        alternateScreen: true,
        scrollbackAnsi: 'FLOATING-PARK-HISTORY\r\n'
      })
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'global-floating-terminal': [{ id: 'tab-1', ptyId: localPtyId }]
        },
        ptyIdsByTabId: { 'tab-1': [localPtyId] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_1]: localPtyId }
          }
        }
      }

      const pane = createPane(1)
      pane.container.getBoundingClientRect = vi.fn(() => createRect(0, 0))
      const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({
        mountFollowsTerminalPark: true,
        worktreeId: 'global-floating-terminal',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: localPtyId }
      })
      connectPanePty(pane as never, createManager(1) as never, deps as never)
      for (let step = 0; step < 30; step += 1) {
        parseCallbacks.shift()?.()
        await flushAsyncTicks(2)
      }

      expect(getMainBufferSnapshot).toHaveBeenCalledOnce()
      expect(getMainBufferSnapshot).toHaveBeenCalledWith(localPtyId, { scrollbackRows: 5000 })
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: localPtyId })
      )
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, localPtyId)
      expect(writes.join('')).toContain('FLOATING-PARK-HISTORY')
      expect(writes.join('')).toContain('FLOATING-PARK-ALT-FRAME')
      expect(writes.filter((write) => write.includes('FLOATING-PARK-ALT-FRAME'))).toHaveLength(1)
      expect(pane.terminal.resize).toHaveBeenCalledWith(113, 32)
    })
  })
}
