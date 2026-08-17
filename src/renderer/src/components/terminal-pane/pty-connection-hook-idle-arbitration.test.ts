import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
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

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.

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

  it('dispatches agent-task-complete on working→idle and raises tab/worktree unread', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    // Why: invoke useNotificationDispatch's body directly (useCallback is pure memo); relies on the file-level vi.mock('react') useCallback pass-through.
    const realDispatchNotification = useNotificationDispatch('wt-1')
    const dispatchNotification = vi.fn((event) => realDispatchNotification(event))
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Fix notification payloads',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      // Why: snapshot agent must match the live completion title ('* Claude done') to be reused; a mismatch is dropped as stale — see use-notification-dispatch.test.ts.
      agentType: 'claude',
      paneKey,
      terminalTitle: '* Claude done',
      stateHistory: [],
      toolName: 'Edit',
      toolInput: 'src/main/ipc/notifications.ts',
      lastAssistantMessage: 'Implemented the formatter.',
      interrupted: false
    }
    mockStoreState.worktreesByRepo.repo2 = [
      { id: 'wt-2', repoId: 'repo2', path: '/tmp/wt-2', displayName: 'feat/other' }
    ]
    mockStoreState.repos.push({ id: 'repo2', connectionId: null, displayName: 'docs' })
    mockStoreState.activeWorktreeId = 'wt-2'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    vi.useFakeTimers()
    idleHandler('* Claude done')

    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    expect(dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude done',
      paneKey
    })
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockStoreState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-1',
        repoLabel: 'orca',
        worktreeLabel: 'feat/notis',
        hasMultipleActiveRepos: true,
        terminalTitle: '* Claude done',
        agentType: 'claude',
        agentState: 'done',
        agentPrompt: 'Fix notification payloads',
        agentToolName: 'Edit',
        agentToolInput: 'src/main/ipc/notifications.ts',
        agentLastAssistantMessage: 'Implemented the formatter.',
        agentInterrupted: false
      })
    )
  })

  it('ignores title-only idle while fresh hook status is still working', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still thinking',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'pi',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('/var/folders/false-idle-title')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('allows an explicit idle title from a different agent than fresh hook status', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'previous agent state',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'pi',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Claude cross-agent done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude cross-agent done',
      paneKey
    })
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('ignores an explicit idle title while fresh hook identity is unknown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still working without a known agent identity',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'unknown',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('Claude Code done')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('ignores a Pi idle title while compatible OMP hook status is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'OMP is still working',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'omp',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('Pi ready')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })
})
