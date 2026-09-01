import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
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

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('keeps terminal UI drawing glyphs on the active renderer', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
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
    const { connectPanePty } = await import('./pty-connection')
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

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-local-detached' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await flushAsyncTicks()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
  })

  it('attaches remote runtime PTY handles instead of creating a replacement terminal', async () => {
    const { connectPanePty } = await import('./pty-connection')
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
    pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => callback?.())
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
    const { connectPanePty } = await import('./pty-connection')
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
    const { connectPanePty } = await import('./pty-connection')
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
          // Pre-U5 record: its captured config is the only copy of the launch the host
          // must replay, so the cold spawn has to surrender it with the resume request.
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          connectionId: null,
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => callback?.())
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
    // Resume travels as an ownership key; the host rebuilds the resume command from
    // the surrendered pre-U5 config plus its recorded execution owner.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        agentLaunch: {
          resume: {
            operation: 'resume',
            sessionKey: {
              worktreeId: 'wt-1',
              baseAgent: 'codex',
              providerSessionId: 'codex-session-1'
            }
          }
        },
        launchAgent: 'codex',
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        },
        legacyResumeRecordedConnectionId: null,
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1'
        })
      })
    )
    // The client neither builds the resume argv nor mints the admission token now.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ command: expect.anything() })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ launchToken: expect.anything() })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.not.objectContaining({ ORCA_AGENT_LAUNCH_TOKEN: expect.anything() })
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
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('does not let a restored encoded PTY override the current worktree owner', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
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
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-2'
      }
    } as StoreState

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
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const tabId = 'web-terminal-host-tab'
    const ptyId = 'remote:hub-web@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
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
    } as StoreState

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
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: ptyId }))
  })

  it('uses a paired-web pane owner to disambiguate duplicate HUB projections', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const tabId = 'web-terminal-host-tab'
    const ptyId = 'remote:hub-b@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
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
    } as StoreState

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
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const ptyId = 'remote:stale-hub@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'stale-hub' }
    } as StoreState

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
  })

  it('uses the focused runtime only for ownerless mixed-version publications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1' }]
      },
      repos: [{ id: 'repo1', connectionId: null }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'legacy-hub' }
    } as StoreState

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('legacy-hub', expect.any(Object))
  })

  it('runs an inline setup terminal locally instead of failing its host closed', async () => {
    // Regression (#9994 fallout): the branded ephemeral-setup id resolves to no worktree/repo, so
    // the strict owner resolver reported it unresolved and gave the pane the "Workspace identity is
    // ambiguous across hosts" error transport instead of a real local PTY.
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const setupWorktreeId =
      'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: setupWorktreeId }) as never
    )

    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
  })

  it('runs an inline setup terminal on the single active runtime for remote skill installs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const setupWorktreeId =
      'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      runtimeEnvironments: [{ id: 'hub-a' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: setupWorktreeId }) as never
    )

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-a', expect.any(Object))
  })

  it('still spawns locally when the worktree row itself proves a local host', async () => {
    // The hydration guard must key off "nothing names the host", not "no repo row" — a
    // worktree stamped hostId 'local' is resolved even before its repo merges.
    const { connectPanePty } = await import('./pty-connection')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-local': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-local', repoId: 'repo1', path: '/tmp/wt-local', hostId: 'local' }]
      },
      repos: []
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: 'wt-local', cwd: '/tmp/wt-local' }) as never
    )

    expect(createIpcPtyTransport).toHaveBeenCalled()
  })

  it('withholds a local spawn while a repo-backed worktree has no hydrated host', async () => {
    // Regression: an SSH worktree whose repo row hadn't merged yet resolved to a null
    // connectionId and spawned on the local daemon with the remote cwd, so the pane never
    // bound a PTY (Docker SSH watcher-isolation timeout).
    const { connectPanePty } = await import('./pty-connection')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-remote': [{ id: 'tab-1', ptyId: null }] },
      // Why: the worktree row exists (so the owner is not "ambiguous") but its repo has
      // not landed yet — exactly the window that used to fail open to local.
      worktreesByRepo: {
        repo1: [{ id: 'wt-remote', repoId: 'repo1', path: '/tmp/orca-docker-relay-perf-repo' }]
      },
      repos: []
    } as StoreState

    const deps = createDeps({
      worktreeId: 'wt-remote',
      cwd: '/tmp/orca-docker-relay-perf-repo'
    })
    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)

    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
  })

  it('keeps the floating terminal local even while a runtime is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'global-floating-terminal': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      runtimeEnvironments: [{ id: 'hub-a' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: 'global-floating-terminal' }) as never
    )

    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
  })

  it('routes a HUB-owned SSH PTY wake hint through the HUB without direct SSH', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const hostPtyId = 'ssh:hub-private@@pty-2'
    mockStoreState = {
      ...mockStoreState,
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
    } as StoreState
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
