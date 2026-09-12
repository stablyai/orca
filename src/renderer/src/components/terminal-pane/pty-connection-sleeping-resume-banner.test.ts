import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
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

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleImagePasteWebglAtlasRecovery: vi.fn(),
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
  scheduleImagePasteWebglAtlasRecovery
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

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(4)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
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
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
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
    // Why: the primary #10757 path — the sidebar resumes a sleeping agent into a new tab,
    // so there is no restored PTY and the spawn is fresh, not a cold restore.
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

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(4)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )

    spawn.resolve({ id: 'fresh-pty', agentResumeUnavailable: true })
    await flushAsyncTicks(10)

    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'resume-unavailable')
  })

  it('lets a declined resume replace an already-shown restored banner', async () => {
    // Why: the banner latch is one-shot per pane. A pane that showed "session restored"
    // and then respawned into a session main declined must stop claiming the restore.
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
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {},
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
    }
    await flushAsyncTicks(10)

    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2, 'restored')

    // Hibernate the pane, then reveal it so the wake respawns the recorded session.
    // Hibernation writes the sleeping record the first spawn consumed.
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = sleepingRecord
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('fresh-pty')
    await flushAsyncTicks(10)
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
