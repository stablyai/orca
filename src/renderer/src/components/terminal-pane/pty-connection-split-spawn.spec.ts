import { bindPtyConnectionTestMocks, ptyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createKeyboardEventTarget,
  createRect,
  createMeasuredElement,
  keyEvent
} from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

export function registerPtyConnectionSplitSpawnTests(): void {
  const { notifyCodexPaneBoundForStaleSweep } = ptyConnectionTestMocks

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

    it('clears the mobile-fit pane binding when the pane connection is disposed', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { getFitOverrideForPane, setFitOverride } =
        await import('@/lib/pane-manager/mobile-fit-overrides')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)

      const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
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

    it('refits immediately when binding to a PTY with an active mobile-fit override', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      Object.defineProperty(pane.container, 'getBoundingClientRect', {
        configurable: true,
        value: () =>
          ({
            width: 800,
            height: 400,
            top: 0,
            left: 0,
            right: 800,
            bottom: 400
          }) as DOMRect
      })
      ;(
        pane.fitAddon as unknown as { proposeDimensions: () => { cols: number; rows: number } }
      ).proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
      pane.terminal.resize.mockImplementation((cols: number, rows: number) => {
        pane.terminal.cols = cols
        pane.terminal.rows = rows
      })
      setFitOverride('pty-fit', 'mobile-fit', 49, 20)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      onPtySpawn?.('pty-fit')

      expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
      expect(pane.terminal.cols).toBe(49)
      expect(pane.terminal.rows).toBe(20)
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

      const { connectPanePty } = await import('./pty-connection')
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

        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
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

    it.each([
      'visible',
      'hidden',
      'starved',
      'cwd',
      'late-cwd',
      'metrics',
      'narrow-command',
      'narrow-plain',
      'narrow-remote',
      'disposed',
      'hide-wait',
      'disposed-hide-wait'
    ])('preserves first-fit startup and bounded fallback: %s', async (scenario) => {
      const visibility = scenario === 'hidden' ? 'hidden' : 'visible'
      const narrow = scenario.startsWith('narrow-')
      const pendingCwd = scenario.includes('cwd') ? createDeferred<string>() : null
      const hideWait = scenario.endsWith('hide-wait')
      let measurable = !pendingCwd && scenario !== 'disposed' && !hideWait
      const frameCallbacks: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      })
      const doc = Object.assign(new EventTarget(), {
        visibilityState: visibility,
        addEventListener: vi.fn(EventTarget.prototype.addEventListener),
        removeEventListener: vi.fn(EventTarget.prototype.removeEventListener)
      })
      vi.stubGlobal('document', doc)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const { connectPanePty } = await import('./pty-connection')
      const { applyOrDeferPaneMetricOptions } =
        await import('@/lib/pane-manager/pane-metric-options-deferral')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      Object.assign(pane.terminal, { cols: 80, rows: 24 })
      const terminalOptions = Object.assign(pane.terminal.options, { fontSize: 12 })
      pane.container = createMeasuredElement({ rect: () => createRect(1200, 800) })
      const dimensions = () => {
        if (!measurable) {
          return { cols: 0, rows: 0 }
        }
        return narrow || terminalOptions.fontSize === 24
          ? { cols: 5, rows: 20 }
          : { cols: 120, rows: 40 }
      }
      pane.fitAddon.proposeDimensions = vi.fn(dimensions)
      pane.fitAddon.fit = vi.fn(() => {
        Object.assign(pane.terminal, dimensions())
      })
      const startup = scenario === 'narrow-plain' ? null : { command: 'claude' }
      const deps = createDeps({
        startup,
        ...(pendingCwd ? { cwdPromise: pendingCwd.promise } : {})
      })
      if (scenario === 'narrow-remote') {
        mockStoreState.repos[0].executionHostId = 'runtime:env-1'
        mockStoreState.worktreesByRepo.repo1[0].runtimeOwnerEnvironmentId = 'env-1'
      }
      const args = mockPanePtyArgs(pane, createManager(1), deps)
      if (scenario === 'metrics') {
        applyOrDeferPaneMetricOptions(args[0], { fontSize: 24 }, false)
      }
      const binding = connectPanePty(...args)

      if (visibility === 'visible' && scenario !== 'starved') {
        frameCallbacks.shift()?.(0)
        const hideListener = doc.addEventListener.mock.calls.at(-1)?.[1]
        if (
          pendingCwd ||
          hideWait ||
          ['metrics', 'disposed', 'narrow-command'].includes(scenario)
        ) {
          expect(transport.connect).not.toHaveBeenCalled()
        }
        if (scenario.startsWith('disposed')) {
          binding.dispose()
        }
        if (hideWait) {
          doc.visibilityState = 'hidden'
          doc.dispatchEvent(new Event('visibilitychange'))
          expect(transport.connect).toHaveBeenCalledTimes(scenario.startsWith('disposed') ? 0 : 1)
          expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', hideListener)
          if (typeof hideListener === 'function') {
            hideListener(new Event('visibilitychange'))
          }
        }
        if (scenario === 'late-cwd') {
          vi.advanceTimersByTime(250)
          expect(transport.connect).not.toHaveBeenCalled()
        }
        pendingCwd?.resolve('/workspace')
        await flushAsyncTicks()
        if (scenario === 'cwd') {
          expect(transport.connect).not.toHaveBeenCalled()
        }
        measurable = true
        terminalOptions.fontSize = 12
        if (scenario === 'narrow-command') {
          for (let retry = 0; retry < 11; retry += 1) {
            frameCallbacks.shift()?.(0)
          }
          expect(transport.connect).not.toHaveBeenCalled()
        }
        frameCallbacks.shift()?.(0)
        expect(transport.connect).toHaveBeenCalledTimes(scenario.startsWith('disposed') ? 0 : 1)
      } else {
        vi.advanceTimersByTime(250)
      }

      vi.advanceTimersByTime(250)
      expect(transport.connect).toHaveBeenCalledTimes(scenario.startsWith('disposed') ? 0 : 1)
      if (scenario.startsWith('disposed')) {
        return
      }
      expect(createdTransportOptions[0]?.command).toBe(startup?.command)
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining(
          narrow || hideWait || scenario === 'late-cwd'
            ? { cols: 80, rows: 24 }
            : { cols: 120, rows: 40 }
        )
      )
    })

    it('spawns the delayed primary pane of an issue-command split when its sibling owns the tab PTY fallback', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const { connectPanePty } = await import('./pty-connection')

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
          createDeps({ paneTransportsRef: sharedTransportsRef })
        )
      )
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(2),
          createDeps({
            startup: { command: 'bash setup-runner.sh' },
            paneTransportsRef: sharedTransportsRef
          })
        )
      )

      const remountDeps = createDeps()
      const remountPane = createPane(1)
      connectPanePty(...mockPanePtyArgs(remountPane, createManager(2), remountDeps))

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

    it('binds a fresh spawn that resolves as a daemon reattach', async () => {
      const { connectPanePty } = await import('./pty-connection')
      let currentPtyId: string | null = null
      const transport = createMockTransport()
      transport.getPtyId.mockImplementation(() => currentPtyId)
      transport.connect.mockImplementation(async () => {
        currentPtyId = 'pty-daemon-reattach'
        return { id: currentPtyId, isReattach: true }
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }

      const pane = createPane(1)
      const deps = createDeps()

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
      await flushAsyncTicks()

      expect(pane.container.dataset.ptyId).toBe('pty-daemon-reattach')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-daemon-reattach')
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-daemon-reattach')
      // Inspect stale CODEX_HOME at first binding because the restored shell retains its original environment.
      expect(notifyCodexPaneBoundForStaleSweep).toHaveBeenCalledWith('pty-daemon-reattach')
    })

    it('replays a stable-pane adoption without submitting the resume command', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
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

    it('drops xterm onData while pane is replaying restored bytes', async () => {
      // Guard replay query replies from leaking through onData into fresh-shell stdin (replay-guard.ts).
      const { connectPanePty } = await import('./pty-connection')

      const transport = createMockTransport('pty-live')
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)
      const manager = createManager(1)
      const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
      const deps = createDeps({ replayingPanesRef })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))

      expect(onDataHandler).toBeDefined()
      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(transport.claimViewport).not.toHaveBeenCalled()

      replayingPanesRef.current.delete(1)
      setFitOverride('pty-live', 'remote-desktop-fit', 80, 24)
      transport.claimViewport.mockClear()
      ;(onDataHandler as (data: string) => void)('a')
      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
      expect(transport.claimViewport).toHaveBeenCalledTimes(1)
      ;(onDataHandler as (data: string) => void)('b')
      // The renderer stays parked until runtime convergence is acknowledged, so a second keystroke can retry a transient failed resize.
      expect(transport.claimViewport).toHaveBeenCalledTimes(2)
      setFitOverride('pty-live', 'desktop-fit', 0, 0)
    })

    it('forwards focus and hover reports without claiming a parked mirror (#26469)', async () => {
      // SIGWINCH can re-arm focus reporting; focus replies must not make different-grid mirrors steal PTY ownership from each other.
      const { connectPanePty } = await import('./pty-connection')
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
      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
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
