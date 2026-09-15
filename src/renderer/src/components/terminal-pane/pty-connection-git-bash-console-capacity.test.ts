import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  sendTerminalInputThroughPane,
  temporarilySetNavigatorUserAgent
} from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
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
let restoreUserAgent: (() => void) | null = null

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
  toast: { info: toastInfo }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the pane connection calls the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
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

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

const WINDOWS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const MACOS_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const CAPACITY_MARKER = 'too many consoles in use, max consoles is 128'
const CAPACITY_OUTPUT = `console device allocation failure - ${CAPACITY_MARKER}`

function installSleepingCodexResumeState(restoredPtyId?: string) {
  const paneKey = makePaneKey('tab-1', LEAF_1)
  const launchConfig = {
    agentCommand: "codex '--model' 'gpt-5'",
    agentArgs: '--model gpt-5',
    agentEnv: { CODEX_PROFILE: 'captured' }
  }
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ...(restoredPtyId ? { ptyId: restoredPtyId } : {}) }]
    },
    settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
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
  return launchConfig
}

type StartedPane = {
  pane: MockPane
  manager: ReturnType<typeof createManager>
  deps: ReturnType<typeof buildPaneConnectionDeps>
  transport: MockTransport
  emitOutput: (data: string) => void
  spawn: (ptyId: string) => void
  exit: (ptyId: string, exitCode?: number) => void
}

/** Connect a local pane whose transport hands back `ptyId`, with its output and lifecycle callbacks exposed. */
async function startPane(
  options: {
    userAgent?: string
    ptyId?: string
    paneCount?: number
    deps?: Record<string, unknown>
  } = {}
): Promise<StartedPane> {
  restoreUserAgent = temporarilySetNavigatorUserAgent(options.userAgent ?? WINDOWS_USER_AGENT)
  const { connectPanePty } = await import('./pty-connection')
  const ptyId = options.ptyId ?? 'tab-pty'
  const callbacks: ConnectCallbacks[] = []
  const transport = createMockTransport(ptyId)
  transport.connect.mockImplementation(async (connectOptions: { callbacks: ConnectCallbacks }) => {
    callbacks.push(connectOptions.callbacks)
    return ptyId
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const manager = createManager(options.paneCount ?? 1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    onPaneProcessDied: vi.fn(),
    ...options.deps
  })

  connectPanePty(pane as never, manager as never, deps as never)

  const transportOptions = createdTransportOptions[0] ?? {}
  return {
    pane,
    manager,
    deps,
    transport,
    emitOutput: (data) => callbacks.at(-1)?.onData?.(data),
    spawn: (spawnedPtyId) => (transportOptions.onPtySpawn as (id: string) => void)?.(spawnedPtyId),
    exit: (exitedPtyId, exitCode) =>
      (transportOptions.onPtyExit as (id: string, code?: number) => void)?.(exitedPtyId, exitCode)
  }
}

function expectCapacityRetention(started: StartedPane, startup: unknown): void {
  expect(started.deps.onPaneProcessDied).toHaveBeenCalledWith({
    paneId: 1,
    exitCode: 1,
    startup,
    reason: 'git-bash-console-capacity'
  })
  expect(started.deps.onPtyExitRef.current).not.toHaveBeenCalled()
  expect(started.manager.closePane).not.toHaveBeenCalled()
}

describe('Git Bash console-capacity pane retention (STA-5604)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    restoreUserAgent = null
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    restoreUserAgent?.()
    await restoreTerminalTestGlobals()
  })

  it('retains a fresh native-Windows PTY that printed the exact capacity marker', async () => {
    const startup = { command: 'codex --resume session-1' }
    const started = await startPane({ deps: { startup } })

    started.spawn('tab-pty')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expectCapacityRetention(started, startup)
  })

  it('detects the marker when it is split across output chunks', async () => {
    const startup = { command: 'codex' }
    const started = await startPane({ deps: { startup } })

    started.spawn('tab-pty')
    started.emitOutput('console device allocation failure - too many consoles ')
    started.emitOutput('in use, max consoles is 128\r\n')
    started.exit('tab-pty', 1)

    expectCapacityRetention(started, startup)
  })

  it('does not classify near-miss console output as a capacity failure', async () => {
    const started = await startPane()

    started.spawn('tab-pty')
    started.emitOutput('too many consoles in use, max consoles is 127')
    started.exit('tab-pty', 1)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('tears down an ordinary non-zero local exit the user asked for', async () => {
    // Why (#16045 regression): `exit` after a failed command is a deliberate close, not a console-capacity failure.
    const started = await startPane()

    started.spawn('tab-pty')
    started.emitOutput('bash: nope: command not found\r\n')
    sendTerminalInputThroughPane(started.pane, 'exit\r')
    started.exit('tab-pty', 1)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(started.deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
  })

  it('does not retain a capacity marker printed after user input', async () => {
    const started = await startPane()

    started.spawn('tab-pty')
    sendTerminalInputThroughPane(started.pane, 'ls\r')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(started.deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
  })

  it('treats an unsettled user write as interaction when the exit beats its acknowledgement', async () => {
    const started = await startPane()
    started.transport.sendInputAccepted?.mockImplementation(() => new Promise<boolean>(() => {}))

    started.spawn('tab-pty')
    sendTerminalInputThroughPane(started.pane, '\u0003')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    // The unchanged sole-pane guard still keeps a never-typed-into newborn mounted,
    // so the load-bearing assertion is that no capacity overlay claims this exit.
    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(started.manager.closePane).not.toHaveBeenCalled()
  })

  it('retains the cold-restore resume startup when its replacement hits capacity', async () => {
    restoreUserAgent = temporarilySetNavigatorUserAgent(WINDOWS_USER_AGENT)
    const { connectPanePty } = await import('./pty-connection')
    const callbacks: ConnectCallbacks[] = []
    const transport = createMockTransport('resume-pty')
    transport.connect.mockImplementation(async (options: { callbacks: ConnectCallbacks }) => {
      callbacks.push(options.callbacks)
      return 'resume-pty'
    })
    transportFactoryQueue.push(transport)
    const launchConfig = installSleepingCodexResumeState()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'codex stale-startup' },
      onPaneProcessDied: vi.fn()
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    const transportOptions = createdTransportOptions[0] ?? {}
    ;(transportOptions.onPtySpawn as (id: string) => void)?.('resume-pty')
    callbacks[0]?.onData?.(CAPACITY_MARKER)
    ;(transportOptions.onPtyExit as (id: string, code?: number) => void)?.('resume-pty', 1)

    expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 1,
      exitCode: 1,
      startup: expect.objectContaining({
        command: expect.stringContaining("'resume' 'codex-session-1'"),
        launchConfig,
        resumeProviderSession: { key: 'session_id', id: 'codex-session-1' },
        launchAgent: 'codex',
        showSessionRestoredBanner: true
      }),
      reason: 'git-bash-console-capacity'
    })
  })

  it('does not carry one PTY capacity match into its cold-restore replacement', async () => {
    restoreUserAgent = temporarilySetNavigatorUserAgent(WINDOWS_USER_AGENT)
    const { connectPanePty } = await import('./pty-connection')
    const callbacks: ConnectCallbacks[] = []
    let currentPtyId = 'lost-pty'
    const transport = createMockTransport(currentPtyId)
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(
      async (options: { sessionId?: string; callbacks: ConnectCallbacks }) => {
        callbacks.push(options.callbacks)
        if (options.sessionId) {
          // Only the lost session printed the marker; its replacement must not inherit the match.
          options.callbacks.onData?.(CAPACITY_MARKER)
          return { id: currentPtyId, sessionExpired: true }
        }
        currentPtyId = 'resume-pty'
        return currentPtyId
      }
    )
    transportFactoryQueue.push(transport)
    installSleepingCodexResumeState('lost-pty')
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      onPaneProcessDied: vi.fn(),
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(30)
    expect(callbacks).toHaveLength(2)
    const transportOptions = createdTransportOptions[0] ?? {}
    ;(transportOptions.onPtySpawn as (id: string) => void)?.('resume-pty')
    ;(transportOptions.onPtyExit as (id: string, code?: number) => void)?.('resume-pty', 1)

    expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('does not retain a reattached PTY that was never freshly spawned', async () => {
    const started = await startPane()

    // No spawn callback: reattach and cold-restore skip onPtySpawn (pty-transport.ts).
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(started.deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
  })

  it('leaves a clean exit alone even when the marker is somewhere in its output', async () => {
    const started = await startPane()

    started.spawn('tab-pty')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 0)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('leaves a Windows-client remote-runtime pane on the unchanged teardown path', async () => {
    // Why: a paired-web mirrored pane keeps its worktree's local execution host, so the
    // native-ConPTY verdict is true on a Windows client even though the PTY runs on the HUB.
    restoreUserAgent = temporarilySetNavigatorUserAgent(WINDOWS_USER_AGENT)
    const { connectPanePty } = await import('./pty-connection')
    const tabId = 'web-terminal-host-tab'
    const ptyId = 'remote:hub-web@@terminal-1'
    const transport = createMockTransport(ptyId)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
      ptyIdsByTabId: { [tabId]: [ptyId] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
    } as StoreState
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      tabId,
      onPaneProcessDied: vi.fn(),
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    const attachCallbacks = (
      transport.attach.mock.calls[0]?.[0] as { callbacks?: ConnectCallbacks } | undefined
    )?.callbacks
    expect(attachCallbacks?.onData).toBeTypeOf('function')
    const transportOptions = createdTransportOptions[0] ?? {}
    ;(transportOptions.onPtySpawn as (id: string) => void)?.(ptyId)
    attachCallbacks?.onData?.(CAPACITY_OUTPUT)
    ;(transportOptions.onPtyExit as (id: string, code?: number) => void)?.(ptyId, 1)

    expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('leaves macOS and Linux local exits on the unchanged teardown path', async () => {
    const started = await startPane({ userAgent: MACOS_USER_AGENT })

    started.spawn('tab-pty')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expect(started.deps.onPaneProcessDied).not.toHaveBeenCalled()
  })

  it('tears the pane down when the host wired no process-died handler', async () => {
    // Why: `onPaneProcessDied` is optional on PaneConnectionDeps. Without the
    // presence check the capacity branch would call `undefined` and abort the exit
    // handler mid-teardown, leaving the pane neither retained nor closed.
    const started = await startPane({
      paneCount: 2,
      deps: {
        onPaneProcessDied: undefined,
        paneTransportsRef: { current: new Map([[2, createMockTransport('pty-pane-2')]]) }
      }
    })

    started.spawn('tab-pty')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expect(started.manager.closePane).toHaveBeenCalledWith(1)
  })

  it('keys an in-flight write to the PTY bound at the time, not the incoming generation', async () => {
    // Why: a new stream generation installs its exit state when its callbacks are
    // captured, which is BEFORE the transport rebinds its PTY id. A write landing in
    // that window belongs to the outgoing PTY; crediting it to the incoming one would
    // make a newborn shell look typed-into and silently drop its capacity overlay.
    const { installPtyExitHibernate } = await import('./pty-connection/pty-exit-hibernate')
    const session = { paneStartup: { command: 'zsh' } } as never as Parameters<
      typeof installPtyExitHibernate
    >[0]
    installPtyExitHibernate(session)

    const outgoing = session.currentProcessExitState
    session.bindProcessExitState('outgoing-pty')
    // The incoming generation's state is installed before its PTY id is bound.
    const incoming = session.createProcessExitState({ command: 'zsh' })
    session.currentProcessExitState = incoming

    session.noteTerminalInputForPty('outgoing-pty')

    expect(outgoing.userInteracted).toBe(true)
    expect(incoming.userInteracted).toBe(false)
  })

  it('keeps a freshly split Windows pane visible when its newborn PTY hits the console ceiling', async () => {
    const startup = { command: 'codex' }
    const started = await startPane({
      paneCount: 2,
      deps: {
        startup,
        paneTransportsRef: { current: new Map([[2, createMockTransport('pty-pane-2')]]) }
      }
    })

    started.spawn('tab-pty')
    started.emitOutput(CAPACITY_OUTPUT)
    started.exit('tab-pty', 1)

    expectCapacityRetention(started, startup)
  })
})
