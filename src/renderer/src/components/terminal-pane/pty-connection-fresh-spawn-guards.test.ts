import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
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

  it('does not surface the zero-dimensions diagnostic for a hidden pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.cols = 0
    pane.terminal.rows = 0
    const deps = createDeps({ isVisibleRef: { current: false } })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('still surfaces the zero-dimensions diagnostic for a visible pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.cols = 0
    pane.terminal.rows = 0
    const deps = createDeps({ isVisibleRef: { current: true } })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      pane.id,
      expect.stringContaining('Terminal has zero dimensions (0×0)')
    )
  })

  // Why: a late exit from a replaced PTY skips onExit's kitty reset, so a fresh spawn must reset the reused per-pane tracker itself or restart-in-place leaks old kitty flags.
  it('resets a stale kitty keyboard mirror when spawning a fresh PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { TerminalKittyKeyboardModeTracker } =
      await import('../../../../shared/terminal-kitty-keyboard-mode-tracker')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const staleTracker = new TerminalKittyKeyboardModeTracker()
    staleTracker.scan('\x1b[>1u')
    expect(staleTracker.flags).toBe(1)
    // Why: a unique tab id keeps this pane's key clear of other tests' pendingSpawnByPaneKey entries so the connect deterministically fresh-spawns.
    const deps = createDeps({
      tabId: 'tab-kitty-fresh-spawn',
      paneKittyKeyboardModesRef: { current: new Map([[91, staleTracker]]) }
    })

    connectPanePty(createPane(91) as never, createManager(91) as never, deps as never)
    await flushAsyncTicks()

    expect(staleTracker.flags).toBe(0)
  })

  // Why: deleting a worktree kills its PTYs for the filesystem teardown; the
  // renderer must not race a doomed respawn into a directory main is deleting
  // (main fences it with TerminalRemovalInProgressError and the pane is about to
  // unmount). See docs — bad UI was the raw fence error flashing on the tab.
  it('skips a fresh spawn while the pane worktree is being deleted', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'deleting' } }
    }
    // Why: a unique tab id keeps this pane's key clear of other tests' pendingSpawnByPaneKey entries so the connect deterministically fresh-spawns.
    const deps = createDeps({ tabId: 'tab-removal-skip-spawn' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('fresh-spawns normally when the pane worktree is not being deleted', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    // Why: unique tab id → deterministic fresh spawn (mirrors the skip test's control).
    const deps = createDeps({ tabId: 'tab-removal-control-spawn' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalled()
  })

  // Why: a doomed pane (or a child pane whose parent worktree is being removed,
  // which startFreshSpawn's own-worktree skip cannot see) can still race a spawn
  // that main fences. reportError must swallow that fence so the tab never flashes
  // the raw "Terminal cannot start while the worktree is being removed" banner.
  it('swallows a worktree-removal fence error instead of surfacing it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE } =
      await import('../../../../shared/worktree/removal-fence-error')
    const transport = createMockTransport()
    const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedOnError.current = callbacks.onError ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)
    const deps = createDeps({ tabId: 'tab-fence-swallow' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    // Why: assert the callback was captured before invoking — optional invocation
    // would let this test false-pass (not.toHaveBeenCalled trivially true) if the
    // transport onError wiring ever broke, exercising no suppression at all.
    expect(capturedOnError.current).toBeTypeOf('function')
    // Electron wraps the rejected ipcMain error with its own prefix; still swallowed.
    capturedOnError.current!(
      `Error invoking remote method 'pty:spawn': Error: ${TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE}`
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('still surfaces non-fence spawn errors through the pane error sink', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedOnError.current = callbacks.onError ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)
    const deps = createDeps({ tabId: 'tab-real-error-surface' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(capturedOnError.current).toBeTypeOf('function')
    capturedOnError.current!('shell exited with code 1')
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(1, 'shell exited with code 1')
  })

  it('threads the resolved local project runtime into IPC terminal transport options', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings,
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
      },
      projects: [{ id: 'repo1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(createdTransportOptions[0]?.projectRuntime).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'repo1',
        reason: 'project-override',
        cacheKey: 'repo1:windows-host'
      }
    })
  })

  it('keeps an explicit host fallback out of the project runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null, forceHostRuntime: true }]
      },
      settings: {
        ...mockStoreState.settings,
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(createdTransportOptions[0]?.projectRuntime).toBeUndefined()
  })

  it('spawns a Floating agent on native Windows beside an active WSL project', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {
        ...mockStoreState.tabsByWorktree,
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          { id: 'tab-floating-agent', ptyId: null, launchAgent: 'codex' }
        ]
      },
      projects: [{ id: 'repo1', localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }],
      settings: {
        ...mockStoreState.settings,
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
      }
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        tabId: 'tab-floating-agent',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        cwd: 'C:\\Users\\alice',
        startup: { launchAgent: 'codex' }
      }) as never
    )
    await flushAsyncTicks()

    expect(createIpcPtyTransport).toHaveBeenCalledOnce()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createdTransportOptions[0]).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      executionHostId: 'local',
      connectionId: null,
      launchAgent: 'codex'
    })
    expect(createdTransportOptions[0]?.projectRuntime).toBeUndefined()
  })

  it('observes live terminal GitHub PR URLs before agent completion', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')

    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 42
      })
    )
  })

  it('surfaces an actionable error when a Codex backfill timeout drops to the shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-codex-backfill-timeout'
    })
    transportFactoryQueue.push(transport)
    const deps = createDeps({
      tabId: 'tab-codex-backfill-timeout',
      startup: { command: 'codex', launchAgent: 'codex' }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()
    capturedDataCallback.current?.('timed out waiting for state db back')
    capturedDataCallback.current?.('fill\r\n')

    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Orca attempts background recovery for managed local and WSL homes')
    )
  })

  it('drops keystrokes while the replay guard is engaged, then forwards once it releases', async () => {
    // Regression (cold-restore reattach lockout): a stuck replay guard dropped every keystroke ("can't type after reconnecting"); engaged guard suppresses input, released forwards it.
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('ssh:ssh-1@@pty-1')
    transportFactoryQueue.push(transport)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1, 1) as never, deps as never)
    await flushAsyncTicks()

    transport.sendInput.mockClear()
    // Engaged (as a stuck reattach would leave it): input must be suppressed.
    deps.replayingPanesRef.current.set(pane.id, 3)
    sendTerminalInputThroughPane(pane, 'echo hi\r')
    expect(transport.sendInput).not.toHaveBeenCalled()

    // Released (via the guard's fallback or parse completion): input flows again.
    deps.replayingPanesRef.current.delete(pane.id)
    sendTerminalInputThroughPane(pane, 'echo hi\r')
    expect(transport.sendInput).toHaveBeenCalledWith('echo hi\r')
  })

  it('settles a queued startup only after the pane binds its spawned PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-resume')
    transportFactoryQueue.push(transport)
    const onStartupBound = vi.fn()
    const startup = {
      command: "codex 'resume' 'codex-session-1'",
      resumeProviderSession: { key: 'session_id', id: 'codex-session-1' } as const
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup, onStartupBound }) as never
    )

    expect(onStartupBound).not.toHaveBeenCalled()
    expect(createdTransportOptions[0]).toMatchObject(startup)

    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.('pty-resume')
    onPtySpawn?.('pty-resume')

    expect(onStartupBound).toHaveBeenCalledTimes(1)
  })
})
