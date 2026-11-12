import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import {
  createMockTransport,
  createPane,
  createManager,
  LEAF_1,
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

export function registerPtyConnectionDeliberateSleepGuardTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('deliberate sleep keeps mounted panes cold', () => {
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
      const { clearWorktreeSleepIntent } =
        await import('@/lib/workspace/sleep/worktree-sleep-intent')
      clearWorktreeSleepIntent('wt-1')
      await restoreTerminalTestGlobals()
    })

    it('does not connect a waiting pane whose tab was remounted by the wake', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/workspace/sleep/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        activeWorktreeId: 'wt-other',
        tabsByWorktree: { 'wt-1': [{ id: 'tab-remounted', ptyId: 'wt-1@@dead', generation: 0 }] }
      }
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({
        tabId: 'tab-remounted',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'wt-1@@dead' },
        isVisibleRef: { current: false }
      })
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(deps, agentTitleMocks4)
        )
      )
      await flushAsyncTicks()

      // Why: activation bumps generation in the same set() that precedes the clear.
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-remounted', ptyId: 'wt-1@@dead', generation: 1 }] }
      }
      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
    })

    // RA-13b: an Orca Cloud workspace that was asleep and selected when Orca quit comes back
    // selected; its restored panes must not reattach (that would wake the sandbox) until Wake.
    it('restored asleep cloud panes never attach after a restart', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const titles = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { holdRestoredAsleepCloudSelection } =
        await import('@/components/sidebar/workspace-actions/sleep/workspace-sleep-view-hold')
      const { cloudVmRecord } =
        await import('@/components/sidebar/workspace-actions/sleep/cloud-vm-record.test-fixture')
      const { resetWorktreeSleepViewForTests } = await import('@/lib/worktree-sleep-view')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = { ...mockStoreState, activeWorktreeId: 'wt-1' }
      expect(holdRestoredAsleepCloudSelection([cloudVmRecord('wt-1', 'suspended')])).toBe('wt-1')
      const deps = createDeps({
        tabId: 'tab-restored',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'wt-1@@slept' }
      })
      connectPanePty(
        ...mockPanePtyArgs(createPane(1), createManager(1), bindPaneAgentTitleMocks(deps, titles))
      )
      await flushAsyncTicks()
      expect(transport.connect).not.toHaveBeenCalled()
      resetWorktreeSleepViewForTests()
    })

    it('a restored running cloud workspace attaches as before', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const titles = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { holdRestoredAsleepCloudSelection } =
        await import('@/components/sidebar/workspace-actions/sleep/workspace-sleep-view-hold')
      const { cloudVmRecord } =
        await import('@/components/sidebar/workspace-actions/sleep/cloud-vm-record.test-fixture')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = { ...mockStoreState, activeWorktreeId: 'wt-1' }
      expect(holdRestoredAsleepCloudSelection([cloudVmRecord('wt-1', 'running')])).toBeNull()
      const deps = createDeps({ tabId: 'tab-running', isVisibleRef: { current: false } })
      connectPanePty(
        ...mockPanePtyArgs(createPane(1), createManager(1), bindPaneAgentTitleMocks(deps, titles))
      )
      await flushAsyncTicks()
      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('re-arms after a wake so a second sleep can hold the pane again', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/workspace/sleep/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      let releaseCwd: (cwd: string) => void = () => {}
      const cwdPromise = new Promise<string>((resolve) => {
        releaseCwd = resolve
      })
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({
        tabId: 'tab-resleep',
        isVisibleRef: { current: false },
        cwdPromise
      })

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(deps, agentTitleMocks6)
        )
      )
      await flushAsyncTicks()
      // Wake: the pane leaves the sleep gate and parks on the cwd gate.
      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()
      // Sleep again before the cwd settles, then wake again.
      markWorktreeSleepIntent('wt-1')
      releaseCwd('/cwd')
      await flushAsyncTicks()
      expect(transport.connect).not.toHaveBeenCalled()
      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('drops the wake listener when a waiting pane is disposed', async () => {
      const sleepIntent = await import('@/lib/workspace/sleep/worktree-sleep-intent')
      const subscribe = sleepIntent.onWorktreeSleepIntentCleared
      const paneWakeListener = vi.fn()
      const subscribeSpy = vi
        .spyOn(sleepIntent, 'onWorktreeSleepIntentCleared')
        .mockImplementation((worktreeId, listener) =>
          subscribe(worktreeId, () => {
            paneWakeListener()
            listener()
          })
        )
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        sleepIntent.markWorktreeSleepIntent('wt-1')
        const deps = createDeps({ tabId: 'tab-disposed', isVisibleRef: { current: false } })

        const binding = connectPanePty(
          ...mockPanePtyArgs(
            createPane(1),
            createManager(1),
            bindPaneAgentTitleMocks(deps, agentTitleMocks7)
          )
        )
        await flushAsyncTicks()
        expect(subscribeSpy).toHaveBeenCalledTimes(1)
        binding.dispose()
        const wakeCalls: number[] = []
        subscribe('wt-1', () => wakeCalls.push(1))
        sleepIntent.clearWorktreeSleepIntent('wt-1')
        await flushAsyncTicks()

        expect(transport.connect).not.toHaveBeenCalled()
        expect(wakeCalls).toHaveLength(1)
        expect(paneWakeListener).not.toHaveBeenCalled()
      } finally {
        subscribeSpy.mockRestore()
      }
    })
  })
}
