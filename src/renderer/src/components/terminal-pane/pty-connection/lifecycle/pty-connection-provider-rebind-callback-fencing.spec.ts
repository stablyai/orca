import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import {
  LEAF_1,
  LEAF_2,
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

export function registerPtyConnectionProviderRebindCallbackFencingTests(): void {
  let restoreUserAgent: (() => void) | undefined
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
      restoreUserAgent?.()
      restoreUserAgent = undefined
      await restoreTerminalTestGlobals()
    })

    it('ignores a late spawn callback after the pane adopted a provider replacement', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks18 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      let transportPtyId = 'terminal-old'
      const transport = createMockTransport(transportPtyId)
      transport.getPtyId = vi.fn(() => transportPtyId)
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(1)

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks18)
      )
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      const onPtyRebind = createdTransportOptions[0]?.onPtyRebind as
        | ((ptyId: string, replacedPtyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      expect(onPtyRebind).toBeTypeOf('function')

      onPtySpawn?.('terminal-old')
      transportPtyId = 'terminal-reconnected'
      onPtyRebind?.('terminal-reconnected', 'terminal-old')

      // Mirror the real store’s atomic tab/layout replacement in this lightweight fixture.
      mockStoreState.tabsByWorktree['wt-1'][0]!.ptyId = 'terminal-reconnected'
      const replacementLayout = mockStoreState.terminalLayoutsByTabId?.['tab-1']
      if (!replacementLayout) {
        throw new Error('test fixture missing terminal layout')
      }
      replacementLayout.ptyIdsByLeafId![LEAF_1] = 'terminal-reconnected'

      onPtySpawn?.('terminal-old')

      expect(pane.container.dataset.ptyId).toBe('terminal-reconnected')
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenLastCalledWith(1, 'terminal-old')
    })

    it('ignores a late split-pane spawn callback when the tab identity belongs to pane one', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks19 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      let transportPtyId = 'terminal-old'
      const transport = createMockTransport(transportPtyId)
      transport.getPtyId = vi.fn(() => transportPtyId)
      transportFactoryQueue.push(transport)
      const manager = createManager(2, 2)
      const deps = createDeps()
      const pane = createPane(2)
      mockStoreState.terminalLayoutsByTabId = {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_1 },
            second: { type: 'leaf', leafId: LEAF_2 },
            ratio: 0.5
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'tab-pty', [LEAF_2]: 'terminal-old' }
        }
      }

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks19)
      )
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      const onPtyRebind = createdTransportOptions[0]?.onPtyRebind as
        | ((ptyId: string, replacedPtyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      expect(onPtyRebind).toBeTypeOf('function')

      onPtySpawn?.('terminal-old')
      transportPtyId = 'terminal-reconnected'
      onPtyRebind?.('terminal-reconnected', 'terminal-old')

      // The tab-level PTY is pane one's fallback; pane two is represented by its leaf binding.
      expect(mockStoreState.tabsByWorktree['wt-1'][0]?.ptyId).toBe('tab-pty')
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId?.[LEAF_2]).toBe(
        'terminal-reconnected'
      )

      onPtySpawn?.('terminal-old')

      expect(pane.container.dataset.ptyId).toBe('terminal-reconnected')
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenLastCalledWith(2, 'terminal-old')
    })

    it('accepts a fresh spawn when the persisted pane still names the retired PTY', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks20 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      let transportPtyId = 'terminal-new'
      const transport = createMockTransport(transportPtyId)
      transport.getPtyId = vi.fn(() => transportPtyId)
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(1)
      mockStoreState.tabsByWorktree['wt-1'] = [{ id: 'tab-1', ptyId: 'terminal-old' }]
      const terminalLayoutsByTabId =
        mockStoreState.terminalLayoutsByTabId ?? (mockStoreState.terminalLayoutsByTabId = {})
      terminalLayoutsByTabId['tab-1'] = {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'terminal-old' }
      }

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks20)
      )
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      onPtySpawn?.('terminal-new')

      expect(pane.container.dataset.ptyId).toBe('terminal-new')
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'terminal-new', 'terminal-old')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenLastCalledWith(1, 'terminal-new')
    })
  })
}
