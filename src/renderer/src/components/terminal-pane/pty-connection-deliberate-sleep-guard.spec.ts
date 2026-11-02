import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  LEAF_1,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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
      const { clearWorktreeSleepIntent } = await import('@/lib/worktree-sleep-intent')
      clearWorktreeSleepIntent('wt-1')
      await restoreTerminalTestGlobals()
    })

    // Why: manual sleep keeps tab.ptyId as a wake hint, so a remount would take the
    // REATTACH arm and the daemon would respawn a shell for the dead id (#10205).
    it('does not reattach a slept pane through its retained session id', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { markWorktreeSleepIntent } = await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        activeWorktreeId: 'wt-other',
        tabsByWorktree: { 'wt-1': [{ id: 'tab-slept', ptyId: 'wt-1@@dead' }] }
      }
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({
        tabId: 'tab-slept',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'wt-1@@dead' },
        isVisibleRef: { current: false }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('does not fresh-spawn a slept pane that has no session id', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { markWorktreeSleepIntent } = await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = { ...mockStoreState, activeWorktreeId: 'wt-other' }
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({ tabId: 'tab-slept-bare', isVisibleRef: { current: false } })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('connects a waiting pane once the workspace is woken', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        activeWorktreeId: 'wt-other',
        tabsByWorktree: { 'wt-1': [{ id: 'tab-woken', ptyId: 'wt-1@@dead' }] }
      }
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({
        tabId: 'tab-woken',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'wt-1@@dead' },
        isVisibleRef: { current: false }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()
      expect(transport.connect).not.toHaveBeenCalled()

      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('does not connect a waiting pane whose tab was remounted by the wake', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/worktree-sleep-intent')
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
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
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

    it('resumes a waiting pane mounted under a unified tab id', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        activeWorktreeId: 'wt-other',
        tabsByWorktree: { 'wt-1': [{ id: 'tab-entity', ptyId: null, generation: 3 }] },
        getTab: (id: string) =>
          id === 'unified-1' ? { id, contentType: 'terminal', entityId: 'tab-entity' } : null
      } as never
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({ tabId: 'unified-1', isVisibleRef: { current: false } })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()
      expect(transport.connect).not.toHaveBeenCalled()

      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('re-arms after a wake so a second sleep can hold the pane again', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/worktree-sleep-intent')
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

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
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
      const { connectPanePty } = await import('./pty-connection')
      const { clearWorktreeSleepIntent, markWorktreeSleepIntent } =
        await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({ tabId: 'tab-disposed', isVisibleRef: { current: false } })

      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      )
      await flushAsyncTicks()
      binding.dispose()
      // Why: the connect body already refuses a disposed session, so prove the
      // listener itself is gone: a wake after dispose reaches no subscriber.
      const wakeCalls: number[] = []
      const { onWorktreeSleepIntentCleared } = await import('@/lib/worktree-sleep-intent')
      onWorktreeSleepIntentCleared('wt-1', () => wakeCalls.push(1))
      clearWorktreeSleepIntent('wt-1')
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
      expect(wakeCalls).toHaveLength(1)
    })

    it('still connects a slept pane that carries a queued startup', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { markWorktreeSleepIntent } = await import('@/lib/worktree-sleep-intent')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      markWorktreeSleepIntent('wt-1')
      const deps = createDeps({
        tabId: 'tab-slept-startup',
        isVisibleRef: { current: false },
        startup: { command: 'printf wake', launchAgent: undefined }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
    })

    it('connects normally once the marker is released', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId: 'tab-awake',
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'wt-1@@live' },
        isVisibleRef: { current: false }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
    })
  })
}
