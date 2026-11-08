import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { UUID_RE } from '../test-fixtures/pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionRemoteRuntimeAttachTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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

    it('reattaches via daemon sessionId when an in-session PTY is live', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
        },
        settings: {
          ...mockStoreState.settings
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
      )

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'pty-local-detached' })
      )
      expect(transport.attach).not.toHaveBeenCalled()
      await flushAsyncTicks()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
    })

    it('attaches remote runtime PTY handles instead of creating a replacement terminal', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue('remote:env-1@@terminal-1')
        callbacks?.onReplayData?.('restored remote prompt $ ')
        callbacks?.onConnect?.()
      })
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-1' }]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      } as StoreState

      const pane = createPane(2)
      pane.terminal.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) =>
        callback?.()
      )
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: 'remote:terminal-1' })
      )
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'remote:env-1@@terminal-1')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
      await vi.waitFor(() =>
        expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(
          'remote:env-1@@terminal-1'
        )
      )
    })

    it('reports remote renderer readiness only after delayed restore output is parsed', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      let remoteCallbacks: ConnectCallbacks | undefined
      transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue('remote:env-1@@terminal-delayed')
        remoteCallbacks = callbacks
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-delayed' }]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      } as StoreState
      const pane = createPane(2)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        pane as never,
        createManager(2) as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks4)
      )
      await flushAsyncTicks()
      expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

      remoteCallbacks?.onReplayData?.('delayed restored prompt $ ')
      remoteCallbacks?.onConnect?.()
      await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
      expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

      for (let step = 0; step < 10; step += 1) {
        await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
        parseCallbacks.shift()?.()
        await flushAsyncTicks()
        if (vi.mocked(window.api.pty.reportRendererSerializerReady!).mock.calls.length > 0) {
          break
        }
      }
      expect(writes.join('')).toContain('delayed restored prompt $ ')
      await vi.waitFor(() =>
        expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(
          'remote:env-1@@terminal-delayed'
        )
      )
    })

    it('cold-spawns slept remote runtime PTYs instead of reattaching the preserved handle', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      enableActiveRuntimeEnvironment('env-1')
      const restoredPtyId = 'remote:env-1@@terminal-1'
      const freshPtyId = 'remote:env-1@@terminal-2'
      const transport = createMockTransport(freshPtyId)
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks, sessionId }: Record<string, unknown>) => {
          capturedDataCallback.current = (callbacks as ConnectCallbacks | undefined)?.onData ?? null
          if (sessionId) {
            throw new Error('slept remote runtime PTYs must not reattach by sessionId')
          }
          const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
            | ((ptyId: string) => void)
            | undefined
          onPtySpawn?.(freshPtyId)
          const connectCallbacks = callbacks as ConnectCallbacks | undefined
          connectCallbacks?.onReplayData?.('shell ready\r\n')
          connectCallbacks?.onConnect?.()
          return freshPtyId
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }]
        },
        ptyIdsByTabId: {
          'tab-1': []
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-1',
          agentCmdOverrides: {}
        },
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

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) =>
        callback?.()
      )
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )
      await flushAsyncTicks(20)
      capturedDataCallback.current?.('shell ready\r\n')
      await new Promise((resolve) => setTimeout(resolve, 70))

      expect(transport.attach).not.toHaveBeenCalled()
      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          // No recorded recipe, so no permission bypass is added to the resumed session.
          command: "codex 'resume' 'codex-session-1'",
          launchAgent: 'codex',
          launchConfig: {
            agentCommand: 'codex',
            agentArgs: '',
            agentEnv: {}
          },
          launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
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
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, null)
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', restoredPtyId)
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, freshPtyId)
      expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', freshPtyId)
      expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(freshPtyId)
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        providerSession: { id: 'codex-session-1' },
        origin: 'quit',
        restoreOnTabOpenOnly: true
      })
    })
  })
}
