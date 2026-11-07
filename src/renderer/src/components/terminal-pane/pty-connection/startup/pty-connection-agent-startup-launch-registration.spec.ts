import type { AgentStatusSlice } from '@/store/slices/agent-status/agent-status-slice-contract'
import { normalizeLaunchConfigRegistrationMetadata } from '@/store/slices/agent-status/agent-status-launch-config'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
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

export function registerPtyConnectionNonAgentLaunchRegistrationTests(): void {
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

    it('clears stale launch config when a pane consumes a non-agent startup command', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ startup: { command: 'echo plain-command' } }) as never,
          agentTitleMocks2
        )
      )
      await flushAsyncTicks()

      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
    })
  })
}

export function registerPtyConnectionUnboundAgentLaunchRegistrationTests(): void {
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

    it('clears launch config when an agent startup spawn produces no PTY', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      const registerLaunchConfig: AgentStatusSlice['registerAgentLaunchConfig'] = (
        key,
        config,
        metadata
      ) => {
        mockStoreState.agentLaunchConfigByPaneKey[key] = {
          launchConfig: config,
          identity: normalizeLaunchConfigRegistrationMetadata(key, metadata)
        }
      }
      mockStoreState.registerAgentLaunchConfig.mockImplementation(registerLaunchConfig)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      } as StoreState

      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({
            startup: {
              command: 'codex',
              launchConfig,
              launchToken: 'launch-token-1',
              launchAgent: 'codex'
            }
          }) as never,
          agentTitleMocks4
        )
      )
      try {
        await flushAsyncTicks(20)
        await vi.advanceTimersByTimeAsync(70)

        expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
          paneKey,
          launchConfig,
          {
            agentType: 'codex',
            launchToken: 'launch-token-1',
            tabId: 'tab-1',
            leafId: LEAF_1
          }
        )
        expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)

        const registerOrder = mockStoreState.registerAgentLaunchConfig.mock.invocationCallOrder[0]
        const clearOrder = mockStoreState.clearAgentLaunchConfig.mock.invocationCallOrder[0]
        expect(registerOrder).toBeDefined()
        expect(clearOrder).toBeDefined()
        expect(registerOrder!).toBeLessThan(clearOrder!)
      } finally {
        binding.dispose()
      }
    })
  })
}
