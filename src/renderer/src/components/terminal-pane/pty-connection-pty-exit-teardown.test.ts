import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
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

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

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

  it('keeps the surviving split pane mounted when an intentional pane-close PTY exit arrives', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, null)
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('defers all exit-side state mutation while worktree shutdown verification is pending', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'committed')
    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 2)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
  })

  it('keeps renderer state intact for an exit deferred through rollback', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('pty-pane-2')

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'rolled-back')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('preserves wake identifiers when exit arrives after a committed shutdown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markCommittedPtyShutdowns } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => false),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined

    markCommittedPtyShutdowns(['pty-pane-2'])
    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a fresh split pane mounted when its newborn PTY exits before output or input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2, 2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) },
      clearExitedPanePtyLayoutBinding: vi.fn(() => {
        mockStoreState = {
          ...mockStoreState,
          terminalLayoutsByTabId: {
            ...mockStoreState.terminalLayoutsByTabId,
            'tab-1': {
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: LEAF_1 },
                second: { type: 'leaf', leafId: LEAF_2 },
                ratio: 0.5
              },
              activeLeafId: LEAF_1,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF_1]: 'pty-pane-1' }
            }
          }
        }
      })
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
    expect(manager.setActivePane).toHaveBeenCalledWith(1, { focus: true })
  })

  it('closes a hidden split pane whose PTY exits before output instead of keeping a ghost', async () => {
    // Why (regression, ghost blank pane): a hidden pane's bytes are withheld by the hidden-delivery gate, so "no output" proves nothing — keeping it strands a blank ghost on reveal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2, 2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      isVisibleRef: { current: false },
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('keeps a worktree sole terminal mounted when its freshly-spawned PTY exits before input (direnv failure)', async () => {
    // Why (regression): a failing .envrc direnv makes the sole terminal's shell exit immediately; routing to onPtyExitRef would close the tab and bounce the user to Landing, so keep it mounted.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    // A genuine fresh spawn (onPtySpawn fires only for non-reattach spawns) the user never typed into.
    onPtySpawn?.('tab-pty')
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a worktree sole terminal mounted when only a captured shortcut preceded the exit', async () => {
    // Why (regression): captured shortcuts refresh the redraw window, but that must not
    // count as "the user typed into this pane" — otherwise Shift+Enter before a direnv
    // failure closes the tab and bounces the user to Landing.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    const binding = connectPanePty(
      createPane(1) as never,
      manager as never,
      deps as never
    ) as unknown as { markShortcutTerminalInputSent: () => void }
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined

    onPtySpawn?.('tab-pty')
    binding.markShortcutTerminalInputSent()
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('tears down the sole terminal when a freshly-spawned PTY exits after the user typed input', async () => {
    // Why: an explicit `exit` (or any typed input) is a deliberate close, not a failed-startup shell, so the worktree should deactivate as before.
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    onPtySpawn?.('tab-pty')
    sendTerminalInputThroughPane(pane, 'exit\r')
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a failed local terminal visible after user input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({ onPaneProcessDied: vi.fn() })

    connectPanePty(pane as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined

    sendTerminalInputThroughPane(pane, 'agent startup\r')
    onPtyExit?.('tab-pty', 1)

    expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 1,
      exitCode: 1,
      startup: null,
      reason: 'process-failed'
    })
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('keeps a failed local split pane visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({ onPaneProcessDied: vi.fn() })

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined
    onPtyExit?.('tab-pty', 1)

    expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 1,
      exitCode: 1,
      startup: null,
      reason: 'process-failed'
    })
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('classifies the Git Bash capacity failure before retaining its pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'tab-pty'
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const startup = { command: 'codex --resume session-1' }
    const deps = createDeps({ onPaneProcessDied: vi.fn(), startup })

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined

    capturedDataCallback.current?.(
      'console device allocation failure - too many consoles in use, max consoles is 128'
    )
    onPtyExit?.('tab-pty', 1)

    expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 1,
      exitCode: 1,
      startup,
      reason: 'git-bash-console-capacity'
    })
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
  })

  it('retains the cold-restore resume startup when its replacement hits capacity', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const callbacks: ConnectCallbacks[] = []
    const transport = createMockTransport('resume-pty')
    transport.connect.mockImplementation(async (options: { callbacks: ConnectCallbacks }) => {
      callbacks.push(options.callbacks)
      return 'resume-pty'
    })
    transportFactoryQueue.push(transport)
    const launchConfig = installSleepingCodexResumeState()
    const deps = createDeps({
      startup: { command: 'codex stale-startup' },
      onPaneProcessDied: vi.fn()
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    callbacks[0]?.onData?.('too many consoles in use, max consoles is 128')
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined
    onPtyExit?.('resume-pty', 1)

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

  it('does not carry capacity detection into a cold-restore replacement', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const callbacks: ConnectCallbacks[] = []
    let currentPtyId = 'lost-pty'
    const transport = createMockTransport(currentPtyId)
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(
      async (options: { sessionId?: string; callbacks: ConnectCallbacks }) => {
        callbacks.push(options.callbacks)
        if (options.sessionId) {
          options.callbacks.onData?.('too many consoles in use, max consoles is 128')
          return { id: currentPtyId, sessionExpired: true }
        }
        currentPtyId = 'resume-pty'
        return currentPtyId
      }
    )
    transportFactoryQueue.push(transport)
    installSleepingCodexResumeState('lost-pty')
    const deps = createDeps({
      onPaneProcessDied: vi.fn(),
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(30)
    expect(callbacks).toHaveLength(2)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined
    onPtyExit?.('resume-pty', 1)

    expect(deps.onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 1,
      exitCode: 1,
      startup: null,
      reason: 'process-failed'
    })
  })

  it('does not retain a failed direct-SSH terminal locally', async () => {
    const { connectPanePty } = await import('./pty-connection')
    mockStoreState = {
      ...mockStoreState,
      repos: [{ ...mockStoreState.repos[0], connectionId: 'ssh-1' }]
    } as StoreState
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({ onPaneProcessDied: vi.fn() })

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as
      | ((ptyId: string, exitCode?: number) => void)
      | undefined
    onPtyExit?.('tab-pty', 1)

    expect(deps.onPaneProcessDied).not.toHaveBeenCalled()
    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
  })

  it('tears down the sole terminal when a reattached (not freshly spawned) PTY exits', async () => {
    // Why: reattach/coldRestore skip onPtySpawn, so a now-dead previously-live session must still route through onPtyExitRef; the keep-mounted guard is only for brand-new shells.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    // No onPtySpawn call: simulates a reattach to a persisted session.
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('rebinds a provider replacement without granting fresh-spawn exit protection', async () => {
    const { connectPanePty } = await import('./pty-connection')
    let transportPtyId = 'terminal-old'
    const transport = createMockTransport(transportPtyId)
    transport.getPtyId = vi.fn(() => transportPtyId)
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(1)

    connectPanePty(pane as never, manager as never, deps as never)
    const onPtyRebind = createdTransportOptions[0]?.onPtyRebind as
      | ((ptyId: string, replacedPtyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyRebind).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    transportPtyId = 'terminal-reconnected'
    onPtyRebind?.('terminal-reconnected', 'terminal-old')

    expect((transport.getPtyId as unknown as () => string | null)()).toBe('terminal-reconnected')
    expect(pane.container.dataset.ptyId).toBe('terminal-reconnected')
    onPtyExit?.('terminal-reconnected')

    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'terminal-reconnected')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      'terminal-reconnected',
      'terminal-old'
    )
    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('terminal-reconnected')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('closes a split pane when an established PTY exits after output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-pane-2')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-pane-2'
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    expect(capturedDataCallback.current).toBeTypeOf('function')

    capturedDataCallback.current?.('shell prompt')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('closes a split pane when an established PTY exits after terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(2)
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(terminalInputHandler).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    terminalInputHandler?.('exit\r')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
  })
})
