import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
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

export function registerPtyConnectionNativeQueryReplyRoutingTests(): void {
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

    it('answers cursor queries while an account notice blocks user input', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-live')
      transportFactoryQueue.push(transport)
      mockStoreState.codexRestartNoticeByPtyId = {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
      const pane = createPane(1)
      const args = mockPanePtyArgs(pane, createManager(1), createDeps())
      bindPaneAgentTitleMocks(args[2], agentTitleMocks3)

      const binding = connectPanePty(...args)
      transport.getPtyId.mockReturnValue('pty-live')
      mockStoreState.codexRestartNoticeByPtyId = {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
      sendTerminalInputThroughPane(pane, '\x1b[1;1R')
      sendTerminalInputThroughPane(pane, 'do work\r')
      expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[1;1R')
      expect(transport.sendInput).not.toHaveBeenCalledWith('do work\r', expect.anything())
      binding.dispose()
    })
  })
}
