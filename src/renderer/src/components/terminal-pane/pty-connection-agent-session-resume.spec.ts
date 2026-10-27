import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectNoWindowStart,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from './pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import {
  LEAF_1,
  LEAF_2,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { AgentStatusSlice } from '@/store/slices/agent-status/agent-status-slice-contract'
import { normalizeLaunchConfigRegistrationMetadata } from '@/store/slices/agent-status/agent-status-launch-config'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionAgentSessionResumeTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  /** Main's frame binding tab-1's pane 2. */
  const bindLeaf2 = bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2)

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

    it('uses sleeping-record launch config for pane cold restore after settings change', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const launchConfig = {
        agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
        agentArgs: '--model gpt-5 --reasoning-effort high',
        agentEnv: {
          CODEX_PROFILE: 'captured',
          ORCA_PANE_KEY: 'wrong-pane',
          ORCA_TAB_ID: 'wrong-tab',
          ORCA_WORKTREE_ID: 'wrong-worktree',
          ORCA_WORKSPACE_ID: 'wrong-workspace'
        }
      }
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {},
          agentDefaultArgs: { codex: '--model changed' },
          agentDefaultEnv: { codex: { CODEX_PROFILE: 'changed' } }
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
            updatedAt: 1,
            launchConfig
          }
        }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main resumes the agent; the window only attaches to the cold-restored terminal and paints it.
        expect(transport.connect).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'lost-pty', attachOnlyView: true })
        )
        expectNoWindowStart(transport, mockStoreState)
        expect(transport.sendInput).not.toHaveBeenCalled()
        return
      }
      const reattachArgs = transport.connect.mock.calls.find(
        ([args]) => args.sessionId === 'lost-pty'
      )?.[0]
      const launchToken = (reattachArgs?.env as Record<string, string> | undefined)
        ?.ORCA_AGENT_LAUNCH_TOKEN

      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(launchToken).toMatch(new RegExp(`^${UUID_RE}$`))
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'lost-pty',
          command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'codex-session-1'",
          env: expect.objectContaining({
            CODEX_PROFILE: 'captured',
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1',
            ORCA_AGENT_LAUNCH_TOKEN: launchToken
          })
        })
      )
      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
        agentType: 'codex',
        launchToken,
        tabId: 'tab-1',
        leafId: LEAF_1
      })
    })

    it('clears stale launch config when a pane consumes a non-agent startup command', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ startup: { command: 'echo plain-command' } }) as never
      )
      await flushAsyncTicks()

      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
    })

    it('ignores a late exit from a transport that no longer owns the pane', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const oldTransport = createMockTransport('old-pty')
      const replacementTransport = createMockTransport('new-pty')
      transportFactoryQueue.push(oldTransport)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      deps.paneTransportsRef.current.set(pane.id, replacementTransport)

      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      onPtyExit?.('old-pty')

      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'old-pty')
      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('old-pty')
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('clears launch config when an agent startup spawn produces no PTY', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('./pty-connection')
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
        createDeps({
          startup: {
            command: 'codex',
            launchConfig,
            launchToken: 'launch-token-1',
            launchAgent: 'codex'
          }
        }) as never
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

    it('prefers live-entry launch config for pane cold restore when status survived PTY loss', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const launchConfig = {
        agentCommand: "codex '--model' 'gpt-5-mini'",
        agentArgs: '--model gpt-5-mini',
        agentEnv: {}
      }
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {},
          agentDefaultArgs: { codex: '--model changed' }
        },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'finish the task',
            agentType: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' }
          }
        },
        agentLaunchConfigByPaneKey: {
          [paneKey]: { launchConfig }
        },
        sleepingAgentSessionsByPaneKey: {}
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main resumes from the live entry; the window only attaches and paints.
        expect(transport.connect).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'lost-pty', attachOnlyView: true })
        )
        expectNoWindowStart(transport, mockStoreState)
        expect(transport.sendInput).not.toHaveBeenCalled()
        return
      }
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'lost-pty',
          command: "codex '--model' 'gpt-5-mini' 'resume' 'codex-session-1'",
          env: expect.objectContaining({
            ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
          })
        })
      )
      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
        agentType: 'codex',
        launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
        tabId: 'tab-1',
        leafId: LEAF_1
      })
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    })

    it.each(['ordinary', 'settled-worker'])(
      'restores %s through main with one resume command',
      async (kind) => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
        const { connectPanePty } = await import('./pty-connection')
        const retainedPtyId = 'wt-1@@lost-pty'
        const transport = createMockTransport()
        transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
          sessionId
            ? {
                id: 'fresh-pty',
                coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
              }
            : 'fresh-pty'
        )
        transportFactoryQueue.push(transport)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: {
            'wt-1': [{ id: 'tab-1', ptyId: retainedPtyId }]
          },
          settings: {
            ...mockStoreState.settings,
            agentCmdOverrides: {}
          },
          agentStatusByPaneKey: {
            [paneKey]: {
              paneKey,
              state: 'working',
              prompt: 'finish the task',
              agentType: 'claude',
              providerSession: { key: 'session_id', id: 'claude-session-1' }
            }
          },
          sleepingAgentSessionsByPaneKey: {
            [paneKey]: {
              paneKey,
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'claude-session-1' },
              prompt: 'finish the task',
              state: 'working',
              capturedAt: 1,
              updatedAt: 1,
              ...(kind === 'settled-worker'
                ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' }
                : {})
            }
          }
        } as StoreState

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          createDeps({
            restoredLeafId: LEAF_1,
            restoredPtyIdByLeafId: { [LEAF_1]: retainedPtyId }
          }) as never
        )
        await flushAsyncTicks(20)
        await vi.advanceTimersByTimeAsync(70)

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          // Main's start carries the one resume; the window's one connect is an attach.
          expect(transport.connect).toHaveBeenCalledTimes(1)
          expect(transport.connect).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: retainedPtyId, attachOnlyView: true })
          )
          expectNoWindowStart(transport, mockStoreState)
          expect(mockStoreState.tabsByWorktree['wt-1']).toHaveLength(1)
          return
        }
        expect(transport.connect).toHaveBeenCalledTimes(1)
        expect(transport.attach).not.toHaveBeenCalled()
        const options = transport.connect.mock.calls[0]?.[0] as {
          sessionId?: string
          command?: string
        }
        expect(options.sessionId).toBe(retainedPtyId)
        expect(options.command).toContain('claude-session-1')
        expect(options.command?.match(/--resume/g)).toHaveLength(1)
        expect(mockStoreState.tabsByWorktree['wt-1']).toHaveLength(1)
      }
    )

    it('ignores stale live launch config when cold restore identity lookup rejects it', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {},
          agentDefaultArgs: { codex: '--model current' }
        },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'finish the task',
            agentType: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' }
          }
        },
        agentLaunchConfigByPaneKey: {
          [paneKey]: {
            launchConfig: {
              agentCommand: "codex '--model' 'stale'",
              agentArgs: '--model stale',
              agentEnv: {}
            }
          }
        },
        getAgentLaunchConfigForStatusEntry: vi.fn(() => undefined),
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'older-codex-session' },
            prompt: 'older task',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1,
            launchConfig: {
              agentCommand: "codex '--model' 'sleeping-stale'",
              agentArgs: '--model sleeping-stale',
              agentEnv: { CODEX_PROFILE: 'sleeping-stale' }
            }
          }
        }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main picks the resume recipe; the window neither builds nor registers one.
        expect(transport.connect).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'lost-pty', attachOnlyView: true })
        )
        expectNoWindowStart(transport, mockStoreState)
        return
      }
      expect(mockStoreState.getAgentLaunchConfigForStatusEntry).toHaveBeenCalledWith(
        expect.objectContaining({ paneKey, agentType: 'codex' })
      )
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'lost-pty',
          // Neither stale recipe applies, and settings defaults never stand in for a recorded one.
          command: "codex 'resume' 'codex-session-1'"
        })
      )
      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
        paneKey,
        expect.objectContaining({
          agentArgs: ''
        }),
        expect.objectContaining({
          agentType: 'codex',
          tabId: 'tab-1',
          leafId: LEAF_1
        })
      )
    })

    it('shows the restored banner when a sleeping resume falls back to a fresh shell', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const staleSessionId = 'wt-1@@stale-session'
      const transport = createMockTransport()
      transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
        if (opts.sessionId) {
          return undefined
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-pty')
        return 'fresh-pty'
      })
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
        restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
      })
      await mainStartsPaneAs({ ptyId: 'pty-main', bind: bindLeaf2, transport })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ sessionId: staleSessionId })
      )
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // A missing reattach asks main to start and preserve the resume record; the window cannot spawn its own shell.
        await expectWindowStartAskedMain(transport, paneKey, mockStoreState)
        expect(transport.connect).toHaveBeenLastCalledWith(
          expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
        )
        expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
        expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
        return
      }
      expect(transport.connect).toHaveBeenNthCalledWith(
        2,
        expect.not.objectContaining({ sessionId: expect.any(String) })
      )
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', staleSessionId)
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining('--- session restored ---'),
        expect.any(Function)
      )
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'restored')
      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    })
  })
}
