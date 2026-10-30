import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
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

export function registerPtyConnectionFreshSpawnGuardsTests(): void {
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

    it('does not surface the zero-dimensions diagnostic for a hidden pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      pane.terminal.cols = 0
      pane.terminal.rows = 0
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    })

    it('still surfaces the zero-dimensions diagnostic for a visible pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      pane.terminal.cols = 0
      pane.terminal.rows = 0
      const deps = createDeps({ isVisibleRef: { current: true } })

      connectPanePty(pane as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
        pane.id,
        expect.stringContaining('Terminal has zero dimensions (0×0)')
      )
    })

    // Do not race PTY respawn into worktree deletion; main’s removal fence must not flash a raw error before unmount.
    it('skips a fresh spawn while the pane worktree is being deleted', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'deleting' } }
      }
      // Use a unique tab ID to avoid pending-spawn entries from other tests and force fresh spawn.
      const deps = createDeps({ tabId: 'tab-removal-skip-spawn' })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    })

    // A queued row may still fail its own delete and stay; a new terminal there must still start.
    it('still spawns while the pane worktree is only queued for deletion', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'queued' } }
      }
      const deps = createDeps({ tabId: 'tab-queued-delete-spawn' })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalled()
    })

    // Read the live store before retiring a disposed spawn, or a remounted pane’s shell could be killed.
    it('lets a disposed spawn survive while the pane surface still exists in the store', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const deps = createDeps({ tabId: 'tab-retain-disposed-spawn' })
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-retain-disposed-spawn', ptyId: null }] }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      const retain = createdTransportOptions[0]?.retainDisposedSpawn
      if (typeof retain !== 'function') {
        throw new Error('pane transport was built without retainDisposedSpawn')
      }
      expect(retain()).toBe(true)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'deleting' } }
      }
      expect(retain()).toBe(false)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: { 'local|wt-1': { isDeleting: true, phase: 'deleting' } }
      }
      expect(retain()).toBe(false)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: {},
        tabsByWorktree: { 'wt-1': [] }
      }
      expect(retain()).toBe(false)
    })

    it('carries the pane placement onto its transport', async () => {
      const { connectPanePty } = await import('./pty-connection')
      transportFactoryQueue.push(createMockTransport())
      const placement = { kind: 'new-tab' } as const
      const deps = createDeps({ tabId: 'tab-placement', placement })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(createdTransportOptions[0]).toMatchObject({ placement })
    })

    it('fresh-spawns normally when the pane worktree is not being deleted', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      // Use a unique tab ID to force fresh spawn, matching the skip control.
      const deps = createDeps({ tabId: 'tab-removal-control-spawn' })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalled()
    })

    // A racing spawn, including under a removing parent worktree, must swallow main’s removal fence instead of flashing its raw banner.
    it('swallows a worktree-removal fence error instead of surfacing it', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE } =
        await import('../../../../shared/worktree/removal-fence-error')
      const transport = createMockTransport()
      const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedOnError.current = callbacks.onError ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({ tabId: 'tab-fence-swallow' })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      // Require captured onError wiring before invoking it; optional invocation could falsely pass without exercising suppression.
      expect(capturedOnError.current).toBeTypeOf('function')
      // Electron wraps the rejected ipcMain error with its own prefix; still swallowed.
      capturedOnError.current!(
        `Error invoking remote method 'pty:spawn': Error: ${TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE}`
      )
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    })

    it('still surfaces non-fence spawn errors through the pane error sink', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedOnError.current = callbacks.onError ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({ tabId: 'tab-real-error-surface' })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(capturedOnError.current).toBeTypeOf('function')
      capturedOnError.current!('shell exited with code 1')
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(1, 'shell exited with code 1')
    })

    it('threads the resolved local project runtime into IPC terminal transport options', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        settings: {
          ...mockStoreState.settings,
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
        },
        projects: [{ id: 'repo1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()

      expect(createdTransportOptions[0]?.projectRuntime).toEqual({
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo1',
          reason: 'project-override',
          cacheKey: 'repo1:windows-host'
        }
      })
    })

    it('keeps an explicit host fallback out of the project runtime', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null, forceHostRuntime: true }]
        },
        settings: {
          ...mockStoreState.settings,
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()

      expect(createdTransportOptions[0]?.projectRuntime).toBeUndefined()
    })

    it('spawns a Floating agent on native Windows beside an active WSL project', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        activeWorktreeId: 'wt-1',
        tabsByWorktree: {
          ...mockStoreState.tabsByWorktree,
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            { id: 'tab-floating-agent', ptyId: null, launchAgent: 'codex' }
          ]
        },
        projects: [
          { id: 'repo1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
        ],
        settings: {
          ...mockStoreState.settings,
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        }
      }

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({
          tabId: 'tab-floating-agent',
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          cwd: 'C:\\Users\\alice',
          startup: { launchAgent: 'codex' }
        }) as never
      )
      await flushAsyncTicks()

      expect(createIpcPtyTransport).toHaveBeenCalledOnce()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createdTransportOptions[0]).toMatchObject({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        executionHostId: 'local',
        launchAgent: 'codex'
      })
      expect(createdTransportOptions[0]?.projectRuntime).toBeUndefined()
    })

    it('observes live terminal GitHub PR URLs before agent completion', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()

      capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')

      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
        'wt-1',
        expect.objectContaining({
          url: 'https://github.com/acme/orca/pull/42',
          slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
          number: 42
        }),
        expect.objectContaining({ tabId: 'tab-1' })
      )
    })

    it('surfaces an actionable error when a Codex backfill timeout drops to the shell', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-codex-backfill-timeout'
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId: 'tab-codex-backfill-timeout',
        startup: { command: 'codex', launchAgent: 'codex' }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()
      capturedDataCallback.current?.('timed out waiting for state db back')
      capturedDataCallback.current?.('fill\r\n')

      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
        1,
        expect.stringContaining('Orca attempts background recovery for managed local and WSL homes')
      )
    })

    it('drops keystrokes while the replay guard is engaged, then forwards once it releases', async () => {
      // A stuck replay guard caused reconnect input lockout; verify suppression while armed and forwarding after release.
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('ssh:ssh-1@@pty-1')
      transportFactoryQueue.push(transport)
      const deps = createDeps()

      connectPanePty(pane as never, createManager(1, 1) as never, deps as never)
      await flushAsyncTicks()

      transport.sendInput.mockClear()
      deps.replayingPanesRef.current.set(pane.id, 3)
      sendTerminalInputThroughPane(pane, 'echo hi\r')
      expect(transport.sendInput).not.toHaveBeenCalled()

      deps.replayingPanesRef.current.delete(pane.id)
      sendTerminalInputThroughPane(pane, 'echo hi\r')
      expect(transport.sendInput).toHaveBeenCalledWith('echo hi\r', 'query-reply')
    })

    it('preserves classified user input during replay while suppressing synthetic replies', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const userInputListeners = new Set<() => void>()
      Object.assign(pane.terminal, {
        _core: {
          coreService: {
            onUserInput: (listener: () => void) => {
              userInputListeners.add(listener)
              return { dispose: () => userInputListeners.delete(listener) }
            }
          }
        }
      })
      const transport = createMockTransport('ssh:ssh-1@@pty-1')
      transportFactoryQueue.push(transport)
      const deps = createDeps()
      const deferred: (() => void)[] = []
      Object.assign(deps, {
        deferPtyInput: (_paneId: number, data: string, forward: (data: string) => void) => {
          deferred.push(() => forward(data))
        }
      })
      connectPanePty(pane as never, createManager(1, 1) as never, deps as never)
      await flushAsyncTicks()
      transport.sendInput.mockClear()
      deps.replayingPanesRef.current.set(pane.id, 1)
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, 'input_under_flood\r')
      sendTerminalInputThroughPane(pane, '\x1b[?1;2c')
      // A click on replayed scrollback that still has mouse tracking armed is user input to xterm, but must not reach the shell.
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[<0;12;4M')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledExactlyOnceWith('input_under_flood\r', 'driving')

      // A wheel over a replayed alt-screen frame becomes cursor keys; the fresh shell must not recall history from them.
      pane.terminal.buffer.active.type = 'alternate'
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[B')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledExactlyOnceWith('input_under_flood\r', 'driving')

      // The same bytes on the normal buffer can only be a keyboard arrow, which survives replay.
      pane.terminal.buffer.active.type = 'normal'
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[B')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledTimes(2)
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x1b[B', 'driving')

      deps.replayingPanesRef.current.delete(pane.id)
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[<0;12;4M')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x1b[<0;12;4M', 'driving')
    })

    it('settles a queued startup only after the pane binds its spawned PTY', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-resume')
      transportFactoryQueue.push(transport)
      const onStartupBound = vi.fn()
      const startup = {
        command: "codex 'resume' 'codex-session-1'",
        resumeProviderSession: { key: 'session_id', id: 'codex-session-1' } as const
      }

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ startup, onStartupBound }) as never
      )

      expect(onStartupBound).not.toHaveBeenCalled()
      expect(createdTransportOptions[0]).toMatchObject(startup)

      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('pty-resume')
      onPtySpawn?.('pty-resume')

      expect(onStartupBound).toHaveBeenCalledTimes(1)
    })
  })
}
