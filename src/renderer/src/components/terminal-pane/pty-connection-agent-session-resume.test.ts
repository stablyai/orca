import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { AgentLaunchResumeRequest } from '../../../../shared/agent-launch-spawn-request'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import { flushAsyncTicks } from './pty-connection-test-async'
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

/** The cold-restore resume spawn the renderer hands the transport. */
type ColdRestoreResumeSpawn = {
  sessionId?: string
  command?: string
  agentLaunch?: AgentLaunchResumeRequest
  launchConfig?: SleepingAgentLaunchConfig
  legacyResumeRecordedConnectionId?: string | null
  env?: Record<string, string>
}

function coldRestoreResumeSpawn(transport: MockTransport): ColdRestoreResumeSpawn {
  return transport.connect.mock.calls[0]?.[0] as ColdRestoreResumeSpawn
}

// Resume argv is host-owned now, so the renderer-side guarantee ends at the
// ownership key + surrendered pre-U5 config. What the host then replays from
// them is pinned in main/agent-launch/cold-restore-resume-handoff.test.ts.
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

  it('uses sleeping-record launch config for pane cold restore after settings change', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    const spawn = coldRestoreResumeSpawn(transport)
    expect(spawn).toMatchObject({
      sessionId: 'lost-pty',
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
      // The captured config is surrendered verbatim for the host to replay.
      launchConfig,
      legacyResumeRecordedConnectionId: null
    })
    expect(spawn.command).toBeUndefined()
    // Pane identity still rides the spawn env; the agent env is host-merged from
    // the config, so the record's stale attribution can never win.
    expect(spawn.env).toMatchObject({
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_WORKSPACE_ID: 'wt-1'
    })
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
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

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('old-pty')

    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'old-pty')
    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('old-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('clears launch config when an agent startup spawn produces no PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
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
      await new Promise((resolve) => setTimeout(resolve, 70))

      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
        agentType: 'codex',
        launchToken: 'launch-token-1',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    const spawn = coldRestoreResumeSpawn(transport)
    expect(spawn).toMatchObject({
      sessionId: 'lost-pty',
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
      // Live entry's config rides the current connection as the legacy handoff.
      launchConfig,
      legacyResumeRecordedConnectionId: null
    })
    expect(spawn.command).toBeUndefined()
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
      tabId: 'tab-1',
      leafId: LEAF_1
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not resume a live provider session while legacy worker recovery owns the pane', async () => {
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
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
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
          updatedAt: 1,
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: retainedPtyId })
    )
    const attachOptions = transport.attach.mock.calls[0]?.[0] as Record<string, unknown>
    expect(attachOptions).not.toHaveProperty('cols')
    expect(attachOptions).not.toHaveProperty('rows')
    expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not replace a missing retained legacy worker over direct SSH', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const retainedPtyId = toAppSshPtyId('ssh-a', 'missing-legacy-worker')
    const transport = createMockTransport()
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.attach.mockImplementation(() => {
      throw new Error('remote PTY missing')
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: retainedPtyId }]
      },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]]),
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
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        }
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: retainedPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: retainedPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
  })

  it('preserves a missing retained legacy worker through direct SSH reconnect', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const retainedPtyId = toAppSshPtyId('ssh-a', 'missing-legacy-worker')
    const transport = createMockTransport()
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.attach.mockImplementation(() => {
      throw new Error('remote PTY missing')
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: retainedPtyId }]
      },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['ssh-a'],
      deferredSshSessionIdsByTabId: { 'tab-1': retainedPtyId },
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
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        }
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: retainedPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(window.api.ssh.connect).toHaveBeenCalledWith({ targetId: 'ssh-a' })
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: retainedPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
  })

  it('ignores stale live launch config when cold restore identity lookup rejects it', async () => {
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
      getAgentLaunchConfigForStatusMetadata: vi.fn(() => undefined),
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
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(mockStoreState.getAgentLaunchConfigForStatusEntry).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey, agentType: 'codex' })
    )
    const spawn = coldRestoreResumeSpawn(transport)
    expect(spawn).toMatchObject({
      sessionId: 'lost-pty',
      agentLaunch: {
        resume: {
          operation: 'resume',
          sessionKey: {
            worktreeId: 'wt-1',
            baseAgent: 'codex',
            providerSessionId: 'codex-session-1'
          }
        }
      }
    })
    // A rejected identity lookup leaves nothing to surrender: neither the stale
    // live config nor the sleeping record's (it names a different session) may
    // reach the host, and none of it is registered as this pane's config.
    expect(spawn.launchConfig).toBeUndefined()
    expect(spawn.command).toBeUndefined()
    expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
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

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: staleSessionId })
    )
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
