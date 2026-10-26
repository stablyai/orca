import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import { runtimeEnvironment } from '../../runtime/server-layout-frames.test-fixture'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionRemoteRuntimeAttachTests(): void {
  let storeFixture: Awaited<ReturnType<typeof createInitialStoreState>>
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(storeFixture, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    storeFixture.patch(buildActiveRuntimeEnvironmentState(storeFixture.read(), environmentId))
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      storeFixture = await createInitialStoreState()
      bindPtyConnectionTestMocks({
        getState: () => storeFixture.read(),
        getStore: () => storeFixture.store,
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
      storeFixture.dispose()
      await restoreTerminalTestGlobals()
    })

    it('keeps terminal UI drawing glyphs on the active renderer', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n')

      expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith(
        '⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n',
        expect.any(Function)
      )
    })

    it('reattaches via daemon sessionId when an in-session PTY is live', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
        },
        settings: {
          ...storeFixture.read().settings
        }
      })

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'pty-local-detached' })
      )
      expect(transport.attach).not.toHaveBeenCalled()
      await flushAsyncTicks()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
    })

    it('attaches remote runtime PTY handles instead of creating a replacement terminal', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const transport = createMockTransport()
      transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue('remote:env-1@@terminal-1')
        callbacks?.onReplayData?.('restored remote prompt $ ')
        callbacks?.onConnect?.()
      })
      transportFactoryQueue.push(transport)

      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-1' }]
        },
        settings: {
          ...storeFixture.read().settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      })

      const pane = createPane(2)
      pane.terminal.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) =>
        callback?.()
      )
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
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
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const transport = createMockTransport()
      let remoteCallbacks: ConnectCallbacks | undefined
      transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        transport.getPtyId.mockReturnValue('remote:env-1@@terminal-delayed')
        remoteCallbacks = callbacks
      })
      transportFactoryQueue.push(transport)
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-delayed' }]
        },
        settings: {
          ...storeFixture.read().settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      })
      const pane = createPane(2)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(pane as never, createManager(2) as never, createDeps() as never)
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
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
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
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }]
        },
        ptyIdsByTabId: {
          'tab-1': []
        },
        settings: {
          ...storeFixture.read().settings,
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
      })

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string | Uint8Array, callback?: () => void) =>
        callback?.()
      )
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
      })

      connectPanePty(pane as never, manager as never, deps as never)
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
      expect(storeFixture.read().clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
    })

    it('does not let a restored encoded PTY override the current worktree owner', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
        },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/tmp/wt-1',
              displayName: 'feat/notis',
              runtimeOwnerEnvironmentId: 'env-2'
            }
          ]
        },
        settings: {
          ...storeFixture.read().settings,
          activeRuntimeEnvironmentId: 'env-2'
        }
      })

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-2', expect.any(Object))
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-1' })
      )
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
    })

    it('routes a paired-web mirrored pane through its session-scoped HUB owner', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const tabId = 'web-terminal-host-tab'
      const ptyId = 'remote:hub-web@@terminal-1'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
        ptyIdsByTabId: { [tabId]: [ptyId] },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'local'
            }
          ]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({
          tabId,
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
        }) as never
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-web', expect.any(Object))
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: ptyId })
      )
    })

    it('uses a paired-web pane owner to disambiguate duplicate HUB projections', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const tabId = 'web-terminal-host-tab'
      const ptyId = 'remote:hub-b@@terminal-1'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
        worktreesByRepo: {
          repo1: [
            { id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1', hostId: 'local' },
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'ssh:private-target',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        }
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({
          tabId,
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
        }) as never
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-b', expect.any(Object))
    })

    it('ignores a stale runtime PTY on an explicitly local non-web pane', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const ptyId = 'remote:stale-hub@@terminal-1'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        settings: { ...storeFixture.read().settings, activeRuntimeEnvironmentId: 'stale-hub' }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).toHaveBeenCalled()
    })

    it('spawns an unstamped local worktree locally while a single server is focused', async () => {
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const worktreeId = 'repo1::/srv/wt-1'
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { [worktreeId]: [{ id: 'tab-1', worktreeId, ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: worktreeId, repoId: 'repo1', path: '/srv/wt-1' }]
        },
        repos: storeFixture
          .read()
          .repos.map((repo) => ({ ...repo, executionHostId: undefined, connectionId: null })),
        settings: { ...storeFixture.read().settings, activeRuntimeEnvironmentId: 'legacy-hub' }
      })

      const binding = await connectMockPanePty(
        createPane(1),
        createManager(1),
        createDeps({ worktreeId })
      )
      try {
        // Why: the client stamps every server row on arrival, so an unstamped row is this machine's.
        expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
        expect(createIpcPtyTransport).toHaveBeenCalled()
      } finally {
        binding.dispose()
      }
    })

    it('runs an inline setup terminal locally instead of failing its host closed', async () => {
      // Synthetic setup IDs have no catalog row; they must resolve locally instead of failing strict ownership as ambiguous (#9994).
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const setupWorktreeId =
        'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ worktreeId: setupWorktreeId }) as never
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    })

    it('runs an inline setup terminal on the single active runtime for remote skill installs', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const setupWorktreeId =
        'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        runtimeEnvironments: [runtimeEnvironment('hub-a', 'hub-a', 1)],
        settings: { ...storeFixture.read().settings, activeRuntimeEnvironmentId: 'hub-a' }
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ worktreeId: setupWorktreeId }) as never
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-a', expect.any(Object))
    })

    it('still spawns locally when the worktree row itself proves a local host', async () => {
      // A local-stamped worktree already names its host before its repo hydrates.
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'wt-local': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-local', repoId: 'repo1', path: '/tmp/wt-local', hostId: 'local' }]
        },
        repos: []
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ worktreeId: 'wt-local', cwd: '/tmp/wt-local' }) as never
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
    })

    it('withholds a local spawn while a repo-backed worktree has no hydrated host', async () => {
      // Missing SSH repo metadata must defer resolution rather than spawn remote cwd paths on the local daemon.
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createIpcPtyTransport } = await import('./pty-transport')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'wt-remote': [{ id: 'tab-1', ptyId: null }] },
        // Why: the worktree row exists (so the owner is not "ambiguous") but its repo has
        // not landed yet — exactly the window that used to fail open to local.
        worktreesByRepo: {
          repo1: [{ id: 'wt-remote', repoId: 'repo1', path: '/tmp/orca-docker-relay-perf-repo' }]
        },
        repos: []
      })

      const deps = createDeps({
        worktreeId: 'wt-remote',
        cwd: '/tmp/orca-docker-relay-perf-repo'
      })
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)

      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    })

    it('keeps the floating terminal local even while a runtime is active', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('./pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: { 'global-floating-terminal': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        runtimeEnvironments: [runtimeEnvironment('hub-a', 'hub-a', 1)],
        settings: { ...storeFixture.read().settings, activeRuntimeEnvironmentId: 'hub-a' }
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ worktreeId: 'global-floating-terminal' }) as never
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    })

    it('routes a HUB-owned SSH PTY wake hint through the HUB without direct SSH', async () => {
      const { connectPanePty } = storeFixture.own(await import('./pty-connection'))
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const hostPtyId = 'ssh:hub-private@@pty-2'
      storeFixture.patch({
        ...storeFixture.read(),
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: hostPtyId }]
        },
        ptyIdsByTabId: { 'tab-1': [hostPtyId] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_1]: hostPtyId }
          }
        },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'ssh:hub-private',
              runtimeOwnerEnvironmentId: 'hub-env'
            }
          ]
        },
        repos: [
          {
            id: 'repo1',
            connectionId: 'hub-private',
            executionHostId: 'runtime:hub-env'
          }
        ]
      })
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: hostPtyId }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-env', expect.any(Object))
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: hostPtyId })
      )
      expect(transport.attach).not.toHaveBeenCalled()
      expect(window.api.ssh.connect).not.toHaveBeenCalled()
      expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
    })
  })
}
