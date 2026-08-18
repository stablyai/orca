import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
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

  it('fails closed when the same SSH worktree id is projected by two HUBs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/same-worktree',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          },
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/same-worktree',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-b'
          }
        ]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'hub-a'
      }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never
    )
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
  })

  it('fails a missing paired-client owner closed instead of creating a local PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/stale-worktree' }]
      },
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
      runtimeEnvironmentCatalogHydrated: true,
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never
    )
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
  })

  it('spawns fresh PTYs through the worktree owner runtime when focus differs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport('remote:owner-runtime@@terminal-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      startup: {
        command: "codex '--profile' 'recipe'",
        launchAgent: 'codex',
        launchConfig: { agentArgs: '--profile recipe', agentEnv: {} },
        agentArgsOverride: '--profile recipe'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith(
      'owner-runtime',
      expect.any(Object)
    )
    expect(createdTransportOptions[0]?.cwdFallback).toBeUndefined()
    expect(createdTransportOptions[0]?.agentArgsOverride).toBe('--profile recipe')
    expect(transport.connect).toHaveBeenCalled()
  })

  it('spawns fresh PTYs locally for explicitly local worktrees while a runtime is focused', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport('pty-local-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'local'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createdTransportOptions[0]?.cwdFallback).toBe('worktree')
    expect(transport.connect).toHaveBeenCalled()
  })

  it('prints a terminal notice when the startup cwd fell back to the workspace root', async () => {
    const { connectPanePty, STARTUP_CWD_FALLBACK_NOTICE } = await import('./pty-connection')
    const transport = createMockTransport('pty-fallback')
    transport.connect.mockResolvedValueOnce({
      id: 'pty-fallback',
      startupCwdFallback: { kind: 'worktree', cwd: '/tmp/wt-1' }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      }
    } as StoreState

    const pane = createPane(2)
    const { writes } = captureCallbackTerminalWrites(pane)

    connectPanePty(pane as never, createManager(2) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(writes).toContain(STARTUP_CWD_FALLBACK_NOTICE)
  })

  it('attaches restored remote PTYs for later split panes instead of spawning host tabs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const existingTransport = createMockTransport('remote:env-1@@terminal-1')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState

    const paneTransports = new Map([[1, existingTransport]])
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {
        [LEAF_2]: 'remote:env-1@@terminal-2'
      },
      paneTransportsRef: { current: paneTransports }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-2' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-2')
  })

  it('persists a restarted pane PTY id and uses it on the next remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const restartedTransport = createMockTransport()
    let spawnedPtyId: string | null = null
    restartedTransport.connect.mockImplementation(async () => {
      spawnedPtyId = 'pty-restarted'
      const opts = createdTransportOptions[0]
      ;(opts.onPtySpawn as (ptyId: string) => void)('pty-restarted')
      return 'pty-restarted'
    })
    transportFactoryQueue.push(restartedTransport)

    const restartPane = createPane(1)
    const restartManager = createManager(1)
    const restartDeps = createDeps({
      paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
    })

    connectPanePty(restartPane as never, restartManager as never, restartDeps as never)
    await flushAsyncTicks()

    expect(spawnedPtyId).toBe('pty-restarted')
    expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    }

    const remountTransport = createMockTransport()
    transportFactoryQueue.push(remountTransport)
    const remountPane = createPane(1)
    const remountManager = createManager(1)
    const remountDeps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'pty-restarted' }
    })

    connectPanePty(remountPane as never, remountManager as never, remountDeps as never)

    expect(remountTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-restarted' })
    )
    expect(remountTransport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')
  })

  // Why: BEL (0x07) is the attention signal — onBell raises worktree/tab/pane unread + an OS notification.
  it('wires onBell to raise worktree unread, tab unread, and OS notification', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    bellHandler()

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'terminal-bell',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('does not raise pane attention on bell when the experimental setting is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    bellHandler()

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  // Kill switch on (default): no byte parsers; pane policy is the PTY's single fact consumer (terminal-side-effect-authority.md).
})
