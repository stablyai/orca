import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import { createKeyboardEventTarget, keyEvent } from '../test-fixtures/pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import type { MockTransport } from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionSplitSpawnTests(): void {
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

    it('clears the mobile-fit pane binding when the pane connection is disposed', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { getFitOverrideForPane, setFitOverride } =
        await import('@/lib/pane-manager/mobile-fit-overrides')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)

      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks)
        )
      )
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      onPtySpawn?.('pty-fit')
      setFitOverride('pty-fit', 'mobile-fit', 49, 20)

      expect(getFitOverrideForPane(1, 'tab-1')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
      expect(pane.container.dataset.ptyId).toBe('pty-fit')

      binding.dispose()

      expect(getFitOverrideForPane(1, 'tab-1')).toBeNull()
      expect(pane.container.dataset.ptyId).toBeUndefined()
    })

    it('continues post-spawn size reconcile after a transient mobile presence lock', async () => {
      const frameCallbacks: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      const runNextFrame = (): void => {
        const callback = frameCallbacks.shift()
        if (!callback) {
          throw new Error('expected a queued animation frame')
        }
        callback(0)
      }

      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

      const ptyId = 'pty-post-spawn-transient-lock'
      setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
      try {
        const transport = createMockTransport(ptyId)
        transportFactoryQueue.push(transport)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
          ptyIdsByTabId: { 'tab-1': [] }
        }
        const pane = createPane(1)
        pane.terminal.cols = 80
        pane.terminal.rows = 24

        connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps(), agentTitleMocks3)
          )
        )
        runNextFrame()
        await flushAsyncTicks()

        pane.terminal.cols = 120
        pane.terminal.rows = 40
        runNextFrame()
        expect(transport.resize).not.toHaveBeenCalled()

        setDriverForPty(ptyId, { kind: 'idle' })
        runNextFrame()

        expect(transport.resize).toHaveBeenCalledWith(120, 40)
      } finally {
        setDriverForPty(ptyId, { kind: 'idle' })
      }
    })

    it('spawns the delayed primary pane of an issue-command split when its sibling owns the tab PTY fallback', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      let mainPtyId: string | null = null
      const mainTransport = createMockTransport()
      mainTransport.getPtyId.mockImplementation(() => mainPtyId)
      mainTransport.attach.mockImplementation(({ existingPtyId }: { existingPtyId: string }) => {
        mainPtyId = existingPtyId
      })
      mainTransport.connect.mockImplementation(async () => {
        mainPtyId = 'pty-main'
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.(mainPtyId)
        return mainPtyId
      })
      let issuePtyId: string | null = null
      const issueTransport = createMockTransport()
      issueTransport.getPtyId.mockImplementation(() => issuePtyId)
      issueTransport.connect.mockImplementation(async () => {
        issuePtyId = 'pty-issue'
        const onPtySpawn = createdTransportOptions[1]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.(issuePtyId)
        return issuePtyId
      })
      transportFactoryQueue.push(mainTransport, issueTransport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const updateStoreTabPtyId = vi.fn((_tabId: string, ptyId: string) => {
        mockStoreState.tabsByWorktree['wt-1'][0].ptyId = ptyId
        const livePtyIds = mockStoreState.ptyIdsByTabId?.['tab-1'] ?? []
        if (!livePtyIds.includes(ptyId)) {
          livePtyIds.push(ptyId)
        }
      })

      const mainPane = createPane(1)
      const issuePane = createPane(2)
      const manager = createManager(2)
      manager.getPanes = vi.fn(() => [mainPane, issuePane])
      const primaryCwd = createDeferred<string>()
      const sharedTransportsRef = { current: new Map() }

      const mainArgs = mockPanePtyArgs(
        mainPane,
        manager,
        createDeps({
          startup: { command: 'codex' },
          cwdPromise: primaryCwd.promise,
          isVisibleRef: { current: false },
          paneTransportsRef: sharedTransportsRef,
          updateTabPtyId: updateStoreTabPtyId
        })
      )
      bindPaneAgentTitleMocks(mainArgs[2], agentTitleMocks5)

      connectPanePty(...mainArgs)
      const issueArgs = mockPanePtyArgs(
        issuePane,
        manager,
        createDeps({
          startup: { command: 'echo issue' },
          isVisibleRef: { current: false },
          paneTransportsRef: sharedTransportsRef,
          updateTabPtyId: updateStoreTabPtyId
        })
      )
      bindPaneAgentTitleMocks(issueArgs[2], agentTitleMocks5)

      connectPanePty(...issueArgs)

      await flushAsyncTicks(20)
      expect(issueTransport.connect).toHaveBeenCalledTimes(1)
      expect(mockStoreState.tabsByWorktree['wt-1'][0].ptyId).toBe('pty-issue')
      expect(mainTransport.connect).not.toHaveBeenCalled()

      primaryCwd.resolve('/workspace')
      await flushAsyncTicks(20)
      expect(mainTransport.attach).not.toHaveBeenCalled()
      expect(mainTransport.connect).toHaveBeenCalledTimes(1)
      expect(mainTransport.connect).toHaveBeenCalledWith(
        expect.not.objectContaining({ sessionId: expect.any(String) })
      )
      expect(createdTransportOptions[0]?.command).toBe('codex')
      expect(createdTransportOptions[1]?.command).toBe('echo issue')
      expect(mainPtyId).toBe('pty-main')
      expect(issuePtyId).toBe('pty-issue')
    })

    it('does not reuse a sibling split pane pending spawn after remount', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )

      const mainSpawn = createDeferred<string>()
      const setupSpawn = createDeferred<string>()

      const mainTransport = createMockTransport()
      mainTransport.connect.mockImplementation(async () => mainSpawn.promise)
      const setupTransport = createMockTransport()
      setupTransport.connect.mockImplementation(async () => setupSpawn.promise)
      const remountTransport = createMockTransport()
      transportFactoryQueue.push(mainTransport, setupTransport, remountTransport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const sharedTransportsRef = { current: new Map() }
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(2),
          bindPaneAgentTitleMocks(
            createDeps({ paneTransportsRef: sharedTransportsRef }),
            agentTitleMocks6
          )
        )
      )
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(2),
          bindPaneAgentTitleMocks(
            createDeps({
              startup: { command: 'bash setup-runner.sh' },
              paneTransportsRef: sharedTransportsRef
            }),
            agentTitleMocks6
          )
        )
      )

      const remountDeps = createDeps()
      const remountPane = createPane(1)
      connectPanePty(
        ...mockPanePtyArgs(
          remountPane,
          createManager(2),
          bindPaneAgentTitleMocks(remountDeps, agentTitleMocks6)
        )
      )

      setupSpawn.resolve('pty-setup')
      mainSpawn.resolve('pty-main')
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }

      expect(remountTransport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: 'pty-main' })
      )
      expect(remountPane.container.dataset.ptyId).toBe('pty-main')
      expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-main')
      expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-main')
    })

    it('replays a stable-pane adoption without submitting the resume command', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const stablePtyId = 'stable-pane-session'
      const transport = createMockTransport()
      transport.connect.mockImplementation(async ({ callbacks }) => {
        callbacks.onReattachDetermined?.()
        transport.getPtyId.mockReturnValue(stablePtyId)
        callbacks.onData?.('NEWER-LIVE-OUTPUT')
        return {
          id: stablePtyId,
          isReattach: true,
          replay: 'ORIGINAL-LIVE-OUTPUT'
        }
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)
      const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({
        startup: { command: 'codex resume provider-session' }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks8))
      )
      await flushAsyncTicks(4)
      if (!onDataHandler || parseCallbacks.length === 0) {
        throw new Error('expected replay and terminal input handlers')
      }
      ;(onDataHandler as (data: string) => void)('DURING_ADOPTION_REPLAY\r')
      expect(transport.sendInput).not.toHaveBeenCalledWith('DURING_ADOPTION_REPLAY\r')
      for (let step = 0; step < 30; step += 1) {
        parseCallbacks.shift()?.()
        await flushAsyncTicks(2)
      }
      ;(onDataHandler as (data: string) => void)('AFTER_ADOPTION_REPLAY\r')

      expect(pane.container.dataset.ptyId).toBe(stablePtyId)
      expect(writes.join('')).toContain('ORIGINAL-LIVE-OUTPUT')
      expect(writes.join('').indexOf('ORIGINAL-LIVE-OUTPUT')).toBeLessThan(
        writes.join('').indexOf('NEWER-LIVE-OUTPUT')
      )
      expect(transport.sendInput).not.toHaveBeenCalledWith('codex resume provider-session\r')
      expect(transport.sendInput).toHaveBeenCalledWith('AFTER_ADOPTION_REPLAY\r', 'query-reply')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, stablePtyId)
    })

    it('forwards focus and hover reports without claiming a parked mirror (#26469)', async () => {
      // SIGWINCH can re-arm focus reporting; focus replies must not make different-grid mirrors steal PTY ownership from each other.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-live')
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
      }
      const keyTarget = createKeyboardEventTarget()
      const pane = createPane(1)
      Object.assign(pane.terminal, { element: keyTarget.target })
      const registered: { onData?: (data: string) => void } = {}
      pane.terminal.onData.mockImplementation((handler: (data: string) => void) => {
        registered.onData = handler
        return { dispose: vi.fn() }
      })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks10)
        )
      )
      const send = registered.onData
      if (!send) {
        throw new Error('expected onData handler to be registered')
      }
      setFitOverride('pty-live', 'remote-desktop-fit', 80, 24)
      transport.claimViewport.mockClear()

      for (const passive of ['\x1b[I', '\x1b[O', '\x1b[<35;10;5M', '\x1b[MC*%']) {
        send(passive)
        expect(transport.sendInput).toHaveBeenCalledWith(passive, 'query-reply')
      }
      expect(transport.claimViewport).not.toHaveBeenCalled()

      // A focus report landing between Ctrl+C's keydown and its byte must not consume the intent.
      keyTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      send('\x1b[I')
      expect(transport.claimViewport).not.toHaveBeenCalled()
      send('\x03')
      expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03', 'query-reply')
      expect(transport.sendInputAccepted).not.toHaveBeenCalledWith('\x1b[I', 'query-reply')
      expect(transport.claimViewport).toHaveBeenCalledTimes(1)

      send('\x1b[<0;10;5M')
      expect(transport.claimViewport).toHaveBeenCalledTimes(2)
      setFitOverride('pty-live', 'desktop-fit', 0, 0)
    })
  })
}
