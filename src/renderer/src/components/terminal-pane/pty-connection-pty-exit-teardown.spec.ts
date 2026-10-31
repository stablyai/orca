import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  sendTerminalInputThroughPane,
  temporarilySetNavigatorUserAgent
} from './pty-connection-test-dom'
import { flushAsyncTicks } from './pty-connection-test-async'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from './pty-connection-test-main-pane-start-fixtures'
import { expectMainFrameClosesExitedSplitPaneOnce } from './pty-connection-test-exited-split-pane-close'
import {
  LEAF_1,
  LEAF_2,
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

export function registerPtyConnectionPtyExitTeardownTests(): void {
  let restoreUserAgent: (() => void) | undefined
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function installSleepingCodexResumeState(restoredPtyId?: string) {
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5'",
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ...(restoredPtyId ? { ptyId: restoredPtyId } : {}) }]
      },
      settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig
        }
      }
    } as StoreState
    return launchConfig
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
      restoreUserAgent?.()
      restoreUserAgent = undefined
      await restoreTerminalTestGlobals()
    })

    it('keeps the surviving split pane mounted when an intentional pane-close PTY exit arrives', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true)
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('pty-pane-2')

      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, null)
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('defers all exit-side state mutation while worktree shutdown verification is pending', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      let pending = true
      const deps = createDeps({
        isPtyShutdownPending: vi.fn(() => pending),
        consumeSuppressedPtyExit: vi.fn(() => true)
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      onPtyExit?.('pty-pane-2')

      expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()

      pending = false
      settleDeferredPtyShutdownExits(['pty-pane-2'], 'committed')
      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
      expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 2)
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    })

    it('keeps renderer state intact for an exit deferred through rollback', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      let pending = true
      const deps = createDeps({
        isPtyShutdownPending: vi.fn(() => pending),
        consumeSuppressedPtyExit: vi.fn(() => true)
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('pty-pane-2')

      pending = false
      settleDeferredPtyShutdownExits(['pty-pane-2'], 'rolled-back')

      expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('preserves wake identifiers when exit arrives after a committed shutdown', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { markCommittedPtyShutdowns } = await import('./pty-shutdown-exit-deferral')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({
        isPtyShutdownPending: vi.fn(() => false),
        consumeSuppressedPtyExit: vi.fn(() => true)
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      markCommittedPtyShutdowns(['pty-pane-2'])
      onPtyExit?.('pty-pane-2')

      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('keeps a fresh split pane mounted when its newborn PTY exits before output or input', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2, 2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) },
        clearExitedPanePtyLayoutBinding: vi.fn(() => {
          mockStoreState = {
            ...mockStoreState,
            terminalLayoutsByTabId: {
              ...mockStoreState.terminalLayoutsByTabId,
              'tab-1': {
                root: {
                  type: 'split',
                  direction: 'horizontal',
                  first: { type: 'leaf', leafId: LEAF_1 },
                  second: { type: 'leaf', leafId: LEAF_2 },
                  ratio: 0.5
                },
                activeLeafId: LEAF_1,
                expandedLeafId: null,
                ptyIdsByLeafId: { [LEAF_1]: 'pty-pane-1' }
              }
            }
          }
        })
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('pty-pane-2')

      expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
      expect(manager.setActivePane).toHaveBeenCalledWith(1, { focus: true })
    })

    it('closes a hidden split pane whose PTY exits before output instead of keeping a ghost', async () => {
      // Hidden delivery withholds bytes, so no output cannot justify retaining an exited ghost pane.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2, 2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        isVisibleRef: { current: false },
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('pty-pane-2')

      expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectMainFrameClosesExitedSplitPaneOnce(manager)
      } else {
        expect(manager.closePane).toHaveBeenCalledWith(2)
      }
    })

    it('keeps a worktree sole terminal mounted when its freshly-spawned PTY exits before input (direnv failure)', async () => {
      // Keep an unused shell mounted after startup failure so direnv errors do not close the tab and return to Landing.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(createPane(1) as never, manager as never, deps as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      expect(onPtyExit).toBeTypeOf('function')

      // A genuine fresh spawn (onPtySpawn fires only for non-reattach spawns) the user never typed into.
      onPtySpawn?.('tab-pty')
      onPtyExit?.('tab-pty')

      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('keeps a worktree sole terminal mounted when only a captured shortcut preceded the exit', async () => {
      // Shortcut-driven redraw activity is not typed input; Shift+Enter must not turn startup failure into tab closure.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      const binding = connectPanePty(
        createPane(1) as never,
        manager as never,
        deps as never
      ) as unknown as { markShortcutTerminalInputSent: () => void }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      onPtySpawn?.('tab-pty')
      binding.markShortcutTerminalInputSent()
      onPtyExit?.('tab-pty')

      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('forwards a synthetic host-loss exit code to the tab-level handler', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(createPane(1) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('tab-pty', -1)

      // Synthetic remote exit is unverifiable; retain the persisted binding for tab-level recovery.
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', -1)
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('keeps a mounted split pane binding across a synthetic host-loss exit', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('pty-pane-2', -1)

      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('pty-pane-2', -1)
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('tears down the sole terminal when a freshly-spawned PTY exits after the user typed input', async () => {
      // Why: an explicit `exit` (or any typed input) is a deliberate close, not a failed-startup shell, so the worktree should deactivate as before.
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      expect(onPtyExit).toBeTypeOf('function')

      onPtySpawn?.('tab-pty')
      sendTerminalInputThroughPane(pane, 'exit\r')
      onPtyExit?.('tab-pty')

      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', 0)
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('tears down a failed local terminal after user input', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps({ onPaneProcessDied: vi.fn() })

      connectPanePty(pane as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined

      sendTerminalInputThroughPane(pane, 'agent startup\r')
      onPtyExit?.('tab-pty', 1)

      expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).toHaveBeenCalled()
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('does not claim a capacity overlay for a failed local split pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({ onPaneProcessDied: vi.fn() })

      connectPanePty(createPane(1) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      onPtyExit?.('tab-pty', 1)

      expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
      expect(manager.closePane).toHaveBeenCalledWith(1)
    })

    it('retains the cold-restore resume startup when its replacement hits capacity', async () => {
      restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const callbacks: ConnectCallbacks[] = []
      const transport = createMockTransport('resume-pty')
      transport.connect.mockImplementation(async (options: { callbacks: ConnectCallbacks }) => {
        callbacks.push(options.callbacks)
        return 'resume-pty'
      })
      transportFactoryQueue.push(transport)
      const launchConfig = installSleepingCodexResumeState()
      const deps = createDeps({
        startup: { command: 'codex stale-startup' },
        onPaneProcessDied: vi.fn()
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(20)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn
      if (typeof onPtySpawn !== 'function') {
        throw new Error('Missing production PTY spawn callback')
      }
      onPtySpawn('resume-pty')
      callbacks[0]?.onData?.('too many consoles in use, max consoles is 128')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      onPtyExit?.('resume-pty', 1)

      expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
        paneId: 1,
        exitCode: 1,
        startup: expect.objectContaining({
          command: expect.stringContaining("'resume' 'codex-session-1'"),
          launchConfig,
          resumeProviderSession: { key: 'session_id', id: 'codex-session-1' },
          launchAgent: 'codex',
          showSessionRestoredBanner: true
        }),
        reason: 'git-bash-console-capacity'
      })
    })

    it('does not carry capacity detection into a cold-restore replacement', async () => {
      restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const callbacks: ConnectCallbacks[] = []
      let currentPtyId = 'lost-pty'
      const transport = createMockTransport(currentPtyId)
      transport.getPtyId.mockImplementation(() => currentPtyId)
      transport.connect.mockImplementation(
        async (options: { sessionId?: string; callbacks: ConnectCallbacks }) => {
          callbacks.push(options.callbacks)
          if (options.sessionId === 'lost-pty') {
            options.callbacks.onData?.('too many consoles in use, max consoles is 128')
            return { id: currentPtyId, sessionExpired: true }
          }
          // Switch on, the replacement is main's start, which the window attaches to.
          currentPtyId = options.sessionId ?? 'resume-pty'
          return options.sessionId ? { id: currentPtyId } : currentPtyId
        }
      )
      transportFactoryQueue.push(transport)
      installSleepingCodexResumeState('lost-pty')
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_1)
        })
      }
      const deps = createDeps({
        onPaneProcessDied: vi.fn(),
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(30)
      expect(callbacks).toHaveLength(2)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectWindowStartAskedMain(transport, makePaneKey('tab-1', LEAF_1))
        expect(currentPtyId).toBe('pty-main')
      }
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      onPtyExit?.(currentPtyId, 1)

      expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
    })

    it('tears down the sole terminal when a reattached (not freshly spawned) PTY exits', async () => {
      // Reattach skips onPtySpawn; the unused-new-shell guard must not retain a dead previously-live session.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('tab-pty')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(createPane(1) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      // No onPtySpawn call: simulates a reattach to a persisted session.
      onPtyExit?.('tab-pty')

      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty', 0)
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('rebinds a provider replacement without granting fresh-spawn exit protection', async () => {
      const { connectPanePty } = await import('./pty-connection')
      let transportPtyId = 'terminal-old'
      const transport = createMockTransport(transportPtyId)
      transport.getPtyId = vi.fn(() => transportPtyId)
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(1)

      connectPanePty(pane as never, manager as never, deps as never)
      const onPtyRebind = createdTransportOptions[0]?.onPtyRebind as
        | ((ptyId: string, replacedPtyId: string) => void)
        | undefined
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string, exitCode?: number) => void)
        | undefined
      expect(onPtyRebind).toBeTypeOf('function')
      expect(onPtyExit).toBeTypeOf('function')

      transportPtyId = 'terminal-reconnected'
      onPtyRebind?.('terminal-reconnected', 'terminal-old')

      expect((transport.getPtyId as unknown as () => string | null)()).toBe('terminal-reconnected')
      expect(pane.container.dataset.ptyId).toBe('terminal-reconnected')
      onPtyExit?.('terminal-reconnected')

      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'terminal-reconnected')
      expect(deps.updateTabPtyId).toHaveBeenCalledWith(
        'tab-1',
        'terminal-reconnected',
        'terminal-old'
      )
      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('terminal-reconnected', 0)
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('ignores a late spawn callback after the pane adopted a provider replacement', async () => {
      const { connectPanePty } = await import('./pty-connection')
      let transportPtyId = 'terminal-old'
      const transport = createMockTransport(transportPtyId)
      transport.getPtyId = vi.fn(() => transportPtyId)
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(1)

      connectPanePty(pane as never, manager as never, deps as never)
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
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)
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
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, manager as never, deps as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      onPtySpawn?.('terminal-new')

      expect(pane.container.dataset.ptyId).toBe('terminal-new')
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'terminal-new', 'terminal-old')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenLastCalledWith(1, 'terminal-new')
    })

    it('closes a split pane when an established PTY exits after output', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')
      expect(capturedDataCallback.current).toBeTypeOf('function')

      capturedDataCallback.current?.('shell prompt')
      onPtyExit?.('pty-pane-2')

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectMainFrameClosesExitedSplitPaneOnce(manager)
      } else {
        expect(manager.closePane).toHaveBeenCalledWith(2)
      }
    })

    it('removes the agent row when an established PTY exits through EOF (#12907)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      onPtyExit?.('pty-pane-2')

      expect(mockStoreState.removeAgentStatus).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_2))
    })

    it('closes a split pane when an established PTY exits after terminal input', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(2)
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      const onDataMock = pane.terminal.onData as unknown as {
        mock: { calls: [[(data: string) => void] | []] }
      }
      const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(terminalInputHandler).toBeTypeOf('function')
      expect(onPtyExit).toBeTypeOf('function')

      terminalInputHandler?.('exit\r')
      onPtyExit?.('pty-pane-2')

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectMainFrameClosesExitedSplitPaneOnce(manager)
      } else {
        expect(manager.closePane).toHaveBeenCalledWith(2)
      }
    })
  })
}
