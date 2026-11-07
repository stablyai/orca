import {
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainStartsPaneAs,
  expectNoWindowStart,
  mainLayoutApplyTransport
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import {
  LEAF_2,
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { UUID_RE } from '../test-fixtures/pty-connection-test-constants'

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

export function registerPtyConnectionSleepingRecordResumeTests(): void {
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

    it('uses sleeping-record launch config for pane cold restore after settings change', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )
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
          command:
            "codex '--model' 'gpt-5' '--reasoning-effort' 'high' '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'",
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
  })
}

export function registerPtyConnectionLiveResumeIdentityTests(): void {
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

    it('prefers live-entry launch config for pane cold restore when status survived PTY loss', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )
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
          command:
            "codex '--model' 'gpt-5-mini' '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'",
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
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks6 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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
          bindPaneAgentTitleMocks(
            createDeps({
              restoredLeafId: LEAF_1,
              restoredPtyIdByLeafId: { [LEAF_1]: retainedPtyId }
            }) as never,
            agentTitleMocks6
          )
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
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks7)
      )
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
          command: "codex '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'"
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
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
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

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )
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
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        paneKey,
        origin: 'quit',
        restoreOnTabOpenOnly: true
      })
    })
  })
}
