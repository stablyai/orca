import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { quoteStartupArg, resolveStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { temporarilySetNavigatorUserAgent } from './pty-connection-test-dom'
import {
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

/** The resume ownership key the client is allowed to send: no argv, no token. */
const RESUME_SESSION_KEY = {
  worktreeId: 'wt-1',
  baseAgent: 'codex',
  providerSessionId: 'codex-session-1'
} as const

/** A pre-U5 sleeping record's captured config — the one-release handoff the host
 *  replays into the resume command. `agentCommand` is the COMPLETE base command
 *  (it already embeds the args), so only the resume argv is quoted at replay. */
const LEGACY_LAUNCH_CONFIG: SleepingAgentLaunchConfig = {
  agentCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
  agentArgs: '--dangerously-bypass-approvals-and-sandbox',
  agentEnv: {}
}

/** What a cold-restore respawn hands the host: the resume key, the legacy
 *  handoff, and the tab's shell — never a command. */
type ColdRestoreResumeSpawn = {
  command?: string
  shellOverride?: string
  launchConfig?: SleepingAgentLaunchConfig
  legacyResumeRecordedConnectionId?: string | null
  agentLaunch?: { resume: { operation: string; sessionKey: Record<string, string> } }
}

/**
 * The resume argv exactly as the host will quote it onto the captured base
 * command: the shell comes from the pane's tab override, falling back to the
 * global Windows setting. This is where the #12320 quoting guarantee now lives —
 * the renderer only forwards the inputs, so that forwarding is what we pin.
 */
function quotedResumeSuffix(spawn: ColdRestoreResumeSpawn, terminalWindowsShell: string): string {
  const shell = resolveStartupShell(
    'win32',
    resolveLocalWindowsAgentStartupShell({
      platform: 'win32',
      isRemote: false,
      shellOverride: spawn.shellOverride,
      terminalWindowsShell
    })
  )
  return ['resume', RESUME_SESSION_KEY.providerSessionId]
    .map((arg) => quoteStartupArg(arg, shell))
    .join(' ')
}

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

  it('delegates a cold-restore resume command after SSH expired-session fallback', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_2)
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (opts.sessionId) {
            opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
            return undefined
          }
          capturedDataCallback.current = opts.callbacks?.onData ?? null
          const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
            | ((ptyId: string) => void)
            | undefined
          onPtySpawn?.('fresh-ssh-pty')
          return 'fresh-ssh-pty'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
        settings: {
          ...mockStoreState.settings,
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
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      capturedDataCallback.current?.('user@remote $ ')
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          // The resume is delegated by ownership key: the host loads its own
          // record and assembles command/delivery/token from it.
          agentLaunch: { resume: { operation: 'resume', sessionKey: RESUME_SESSION_KEY } },
          launchAgent: 'codex',
          env: expect.objectContaining({
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1'
          })
        })
      )
      const respawn = transport.connect.mock.calls[1]?.[0] as ColdRestoreResumeSpawn & {
        env?: Record<string, string>
      }
      expect(respawn.command).toBeUndefined()
      expect(respawn.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
      // The resume must ride the respawn, never be typed into the fresh shell.
      expect(transport.sendInput).not.toHaveBeenCalled()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('re-runs the resume command when a hibernated local session reattaches with no payload', async () => {
    // Why: the daemon drops startup commands on reattach, so a passive hibernation record must replace a contentless adopted shell.
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_2)
      let activePtyId: string | null = 'restored-session'
      const transport = createMockTransport('restored-session')
      transport.getPtyId.mockImplementation(() => activePtyId)
      transport.disconnect.mockImplementation(() => {
        activePtyId = null
      })
      transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
        if (opts.sessionId) {
          activePtyId = opts.sessionId
          return {
            id: opts.sessionId,
            isReattach: true,
            snapshot: undefined,
            replay: undefined,
            coldRestore: undefined
          }
        }
        activePtyId = 'fresh-resume-pty'
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-resume-pty')
        return 'fresh-resume-pty'
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
        settings: {
          ...mockStoreState.settings,
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
            // Mirrors the user's scenario: a stopped/completed agent that hibernated.
            state: 'done',
            origin: 'worktree-sleep',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } as StoreState
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })
      vi.mocked(window.api.pty.declarePendingPaneSerializer)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      for (const fn of pendingTimeouts) {
        fn()
      }
      await flushAsyncTicks(10)

      expect(transport.disconnect).toHaveBeenCalledTimes(1)
      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          // Host-owned resume: only the ownership key crosses, never argv or a token.
          agentLaunch: { resume: { operation: 'resume', sessionKey: RESUME_SESSION_KEY } },
          env: expect.objectContaining({ ORCA_PANE_KEY: paneKey })
        })
      )
      const respawn = transport.connect.mock.calls[1]?.[0] as ColdRestoreResumeSpawn & {
        env?: Record<string, string>
      }
      expect(respawn.command).toBeUndefined()
      expect(respawn.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
      // The dead session is not adopted as the pane's live PTY.
      expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
      expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, 'restored-session')
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-resume-pty')
      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(paneKey, 1)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  // Regression (#12320): a cold restore after reboot typed PowerShell single quotes into
  // cmd.exe tabs, so the agent CLI rejected the resume argv ("unexpected argument").
  // The renderer no longer quotes anything — it forwards the tab's shell and the
  // pre-U5 config, and the host builds the command — so each case drives both halves.
  async function runWindowsColdRestoreResume(args: {
    terminalWindowsShell: string
    tabShellOverride?: string
  }): Promise<ColdRestoreResumeSpawn> {
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_2)
      let activePtyId: string | null = 'restored-session'
      const transport = createMockTransport('restored-session')
      transport.getPtyId.mockImplementation(() => activePtyId)
      transport.disconnect.mockImplementation(() => {
        activePtyId = null
      })
      transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
        if (opts.sessionId) {
          activePtyId = opts.sessionId
          return {
            id: opts.sessionId,
            isReattach: true,
            snapshot: undefined,
            replay: undefined,
            coldRestore: undefined
          }
        }
        activePtyId = 'fresh-resume-pty'
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-resume-pty')
        return 'fresh-resume-pty'
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              ptyId: 'restored-session',
              ...(args.tabShellOverride ? { shellOverride: args.tabShellOverride } : {})
            }
          ]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {},
          terminalWindowsShell: args.terminalWindowsShell
        },
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'finish the task',
            state: 'done',
            origin: 'worktree-sleep',
            // A pre-U5 record: its captured config is the one-release handoff the
            // host replays, so the shell it is quoted for is observable here.
            launchConfig: LEGACY_LAUNCH_CONFIG,
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } as StoreState
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })
      vi.mocked(window.api.pty.declarePendingPaneSerializer)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)

      connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
      await flushAsyncTicks(20)
      for (const fn of pendingTimeouts) {
        fn()
      }
      await flushAsyncTicks(10)

      const spawn = transport.connect.mock.calls.at(-1)?.[0] as ColdRestoreResumeSpawn
      return {
        ...spawn,
        // The tab's shell rides the transport options, not the per-connect override.
        shellOverride: createdTransportOptions[0]?.shellOverride as string | undefined
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout
      restoreNavigator()
    }
  }

  it('quotes a cold-restore resume command for a cmd.exe Windows tab', async () => {
    const spawn = await runWindowsColdRestoreResume({ terminalWindowsShell: 'cmd.exe' })
    expect(spawn.command).toBeUndefined()
    expect(spawn.agentLaunch).toEqual({
      resume: { operation: 'resume', sessionKey: RESUME_SESSION_KEY }
    })
    expect(spawn.launchConfig).toEqual(LEGACY_LAUNCH_CONFIG)
    expect(spawn.shellOverride).toBeUndefined()
    expect(quotedResumeSuffix(spawn, 'cmd.exe')).toBe('"resume" "codex-session-1"')
  })

  it('prefers the tab shell override over the global Windows shell on cold restore', async () => {
    const spawn = await runWindowsColdRestoreResume({
      terminalWindowsShell: 'powershell.exe',
      tabShellOverride: 'cmd.exe'
    })
    expect(spawn.command).toBeUndefined()
    expect(spawn.shellOverride).toBe('cmd.exe')
    expect(quotedResumeSuffix(spawn, 'powershell.exe')).toBe('"resume" "codex-session-1"')
  })

  it('keeps PowerShell quoting for a cold-restore resume on a PowerShell Windows tab', async () => {
    const spawn = await runWindowsColdRestoreResume({ terminalWindowsShell: 'powershell.exe' })
    expect(spawn.command).toBeUndefined()
    expect(spawn.shellOverride).toBeUndefined()
    expect(quotedResumeSuffix(spawn, 'powershell.exe')).toBe("'resume' 'codex-session-1'")
  })

  it('keeps a contentless reattach when the sleeping record represents a live session', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const paneKey = makePaneKey('tab-1', LEAF_2)
    const transport = createMockTransport('restored-session')
    transport.connect.mockResolvedValue({
      id: 'restored-session',
      isReattach: true,
      snapshot: undefined,
      replay: undefined,
      coldRestore: undefined
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          origin: 'live',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('keeps a contentless reattach when a live status supersedes passive sleep evidence', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const paneKey = makePaneKey('tab-1', LEAF_2)
    const transport = createMockTransport('restored-session')
    transport.connect.mockResolvedValue({
      id: 'restored-session',
      isReattach: true,
      snapshot: undefined,
      replay: undefined,
      coldRestore: undefined
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'new live task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'live-codex-session' },
          paneKey,
          updatedAt: 2,
          stateStartedAt: 2,
          stateHistory: []
        }
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'old-codex-session' },
          prompt: 'old completed task',
          state: 'done',
          origin: 'worktree-sleep',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.disconnect).not.toHaveBeenCalled()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('clears the pending serializer when disposed before non-deferred SSH reattach expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_2),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })
})
