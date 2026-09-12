import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS,
  AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS
} from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPaneContainer,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
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

  it('leaves SSH IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-ssh')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('lets delayed hook completion notifications win over concurrent terminal bells', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    vi.advanceTimersByTime(
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1),
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          prompt: 'finish the implementation',
          agentType: 'codex',
          lastAssistantMessage: 'Done.'
        })
      })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['tab-pty'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'tab-pty' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes via title tracking', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!statusHandler || !bellHandler || !workingHandler) {
      throw new Error('Expected hook status, bell, and working handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Milestone complete.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when the pending agent completion is canceled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!bellHandler || !idleHandler || !workingHandler) {
      throw new Error('Expected bell, idle, and working handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    workingHandler()
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('cancels a title task-complete notification when the agent resumes before quiet', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!idleHandler || !workingHandler) {
      throw new Error('Expected idle and working handlers to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Codex done',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
  })

  // Why: a DOM keydown signals "user is here"; raw xterm onData is lower-level (can include terminal replies/control bytes).
  it('clears tab and worktree unread on real keydown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'a' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('clears tab, pane, and worktree unread on plain Escape keydown', async () => {
    // Why: plain Escape is real input (\x1b) — a genuine "user is here" signal; the interrupt-intent early return must not skip the unread clears.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'Escape' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'altKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
  })

  it('does not clear pane attention from raw onData after a bell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler || !onDataHandler) {
      throw new Error('expected bell and onData handlers to be registered')
    }

    bellHandler()
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearTerminalPaneUnread).not.toHaveBeenCalled()
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  // Why: xterm auto-replies during replay must not count as user interaction, or a BELed pane would self-dismiss unseen.
  it('does not clear unread when onData fires during replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
  })

  // Why: on a stale-codex pane (pending account-switch restart), onData bytes must not count as user interaction; production also blocks sendInput here.
  it('does not clear unread when onData fires on a stale codex pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    // isCodexPaneStale reads codexRestartNoticeByPtyId; seed a restart notice to trigger the stale branch.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
    // Stale-codex input is also blocked from reaching the transport.
    expect(transport.sendInput).not.toHaveBeenCalled()
  })
})
