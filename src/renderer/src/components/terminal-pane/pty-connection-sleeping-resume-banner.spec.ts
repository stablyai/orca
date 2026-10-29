import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs,
  publishesResumeOutcomeInStore
} from './pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import {
  LEAF_2,
  createMockTransport,
  createPane,
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

export function registerPtyConnectionSleepingResumeBannerTests(): void {
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

    it('resumes a local sleeping pane in place when the restored PTY hint is missing', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const spawn = createDeferred<string>()
      const transport = createMockTransport()
      transport.connect.mockImplementation(() => spawn.promise)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_2)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null }]
        },
        ptyIdsByTabId: {
          'tab-1': []
        },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_2 },
            activeLeafId: LEAF_2,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
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
            updatedAt: 1
          }
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: {}
      })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2),
          transport
        })
      }

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(4)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main owns resume and record consumption; attach must not show a window-owned restored banner.
        await expectWindowStartAskedMain(transport, paneKey, mockStoreState)
        await flushAsyncTicks(10)
        expect(transport.connect).toHaveBeenCalledTimes(1)
        expect(transport.connect).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
        expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
        return
      }
      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          // The record holds no launch recipe, so the resume adds no permission bypass.
          command: "codex 'resume' 'codex-session-1'",
          launchAgent: 'codex',
          env: expect.objectContaining({
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1',
            ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
          })
        })
      )
      expect(transport.connect).toHaveBeenCalledWith(
        expect.not.objectContaining({ sessionId: expect.any(String) })
      )
      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
        paneKey,
        {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: {}
        },
        {
          agentType: 'codex',
          launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
          tabId: 'tab-1',
          leafId: LEAF_2
        }
      )
      expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()

      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-pty')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-pty')
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-pty')
      expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()

      spawn.resolve('fresh-pty')
      await flushAsyncTicks(10)

      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'restored')
      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    })

    it('says the fresh-spawn resume started fresh when main declined it', async () => {
      // Sidebar resume creates a fresh tab without a restored PTY; it still needs a resume banner (#10757).
      const { connectPanePty } = await import('./pty-connection')
      const spawn = createDeferred<{ id: string; agentResumeUnavailable: true }>()
      const transport = createMockTransport()
      transport.connect.mockImplementation(() => spawn.promise)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_2)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null }]
        },
        ptyIdsByTabId: {
          'tab-1': []
        },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_2 },
            activeLeafId: LEAF_2,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
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
            updatedAt: 1
          }
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: {}
      })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: (ptyId) => {
            bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2)(ptyId)
            publishesResumeOutcomeInStore(
              () => mockStoreState,
              paneKey,
              'resume-unavailable'
            )(ptyId)
          },
          transport
        })
      }

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(4)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main starts the pane and declines its resume; the window attaches and says so.
        await expectWindowStartAskedMain(transport, paneKey, mockStoreState)
        await flushAsyncTicks(10)
        expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
        expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'resume-unavailable')
        return
      }
      expect(transport.connect).toHaveBeenCalledWith(
        expect.not.objectContaining({ sessionId: expect.any(String) })
      )

      spawn.resolve({ id: 'fresh-pty', agentResumeUnavailable: true })
      await flushAsyncTicks(10)

      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'resume-unavailable')
    })

    it('lets a declined resume replace an already-shown restored banner', async () => {
      // A later declined resume must clear an earlier restored-banner latch.
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      let connectCount = 0
      transport.connect.mockImplementation(async () => {
        connectCount += 1
        // The wake respawn is the one main declines; the first spawn is an ordinary resume.
        const spawnedPtyId = connectCount === 1 ? 'fresh-pty' : 'woken-pty'
        transport.getPtyId.mockReturnValue(spawnedPtyId)
        return connectCount === 1
          ? spawnedPtyId
          : { id: spawnedPtyId, agentResumeUnavailable: true as const }
      })
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_2)
      const sleepingRecord = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'codex-session-1' },
        prompt: 'finish the task',
        state: 'done' as const,
        capturedAt: 1,
        updatedAt: 1,
        origin: 'worktree-sleep' as const
      }
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null }]
        },
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_2 },
            activeLeafId: LEAF_2,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        },
        settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
        agentStatusByPaneKey: {},
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleepingRecord },
        suppressedPtyExitIds: { 'fresh-pty': true }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const isVisibleRef = { current: true }
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: {},
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef
      })

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await mainStartsPaneAs({
          ptyId: 'pty-main',
          bind: (ptyId) => {
            bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2)(ptyId)
            publishesResumeOutcomeInStore(() => mockStoreState, paneKey, 'restored')(ptyId)
          },
          transport
        })
      }
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      await flushAsyncTicks(10)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main starts and resumes the pane; the window attaches and shows main's outcome once.
        await expectWindowStartAskedMain(transport, paneKey, mockStoreState)
        expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
        expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'restored')
        return
      }
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'restored')
      isVisibleRef.current = false

      // Hibernate the pane, then reveal it so the wake respawns the recorded session.
      // Hibernation writes the sleeping record the first spawn consumed.
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = sleepingRecord
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('fresh-pty')
      await flushAsyncTicks(10)
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(connectCount).toBeGreaterThan(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenLastCalledWith(2, 'resume-unavailable')
    })

    it('keeps sleeping resume record when fresh cold-restore spawn fails', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const staleSessionId = 'wt-1@@stale-session'
      const transport = createMockTransport()
      transport.connect.mockResolvedValue(undefined)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_2)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: staleSessionId }]
        },
        ptyIdsByTabId: {
          'tab-1': [staleSessionId]
        },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_2 },
            activeLeafId: LEAF_2,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_2]: staleSessionId }
          }
        },
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
            updatedAt: 1
          }
        }
      } as StoreState

      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
      })

      connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    })

    it('forwards one sidebar resume spawn without writing the restored banner through xterm', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const providerSession = { key: 'session_id', id: 'codex-session-1' } as const

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({
          startup: {
            command: "codex 'resume' 'codex-session-1'",
            resumeProviderSession: providerSession,
            showSessionRestoredBanner: true
          }
        }) as never
      )
      await flushAsyncTicks(10)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('pty-1')
      await new Promise((resolve) => setTimeout(resolve, 70))

      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining('--- session restored ---'),
        expect.any(Function)
      )
      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(createdTransportOptions[0]).toMatchObject({
        command: "codex 'resume' 'codex-session-1'",
        resumeProviderSession: providerSession
      })
    })
  })
}
