import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  leafIdForPane,
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

  it('disarms input modes and resumes a hibernated agent session on visibility reveal', async () => {
    // Regression: hibernation suppresses its kill's PTY exit while hidden; before the wake fix onExit permanently latched handledExitPtyId, leaving a frozen inert ghost pane on reveal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    // Hibernation only targets hidden panes, so the exit lands while not visible and the wake must wait for the reveal.
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-1' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    // The deferred connect attached this transport to the persisted tab PTY, so the kill's exit must carry that id for the wake guard's same-pty check.
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // The frozen frame's input-eating modes are disarmed at hibernation-exit (mouse tracking / bracketed paste would otherwise swallow clicks).
    const writesAfterExit = pane.terminal.write.mock.calls.flat().join('')
    expect(writesAfterExit).toContain('\x1b[?1003l')
    expect(writesAfterExit).toContain('\x1b[?2004l')
    // A hidden pane must not respawn on exit — the wake waits for the reveal.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    binding.noteVisibilityResume()
    await flushAsyncTicks()

    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-1')

    // The wake is one-shot: a second reveal must not spawn again.
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('resumes a hibernated agent from a navigation-free wake without a visibility reveal', async () => {
    // Mobile wake fanout drives wakeHibernatedAgentIfArmed on a still-hidden pane (no isVisible flip): the armed --resume must fire exactly once even if delivered twice (INV-1).
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-bg' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    // Still hidden: no reveal happened, so nothing respawned on exit.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    // The wake reports the claim it consumed so the dispatcher's generic resume never launches the same provider session into a second tab.
    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-bg'
    expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
    const claimedProviderSessions = new Set<string>()
    expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
    expect(claimedProviderSessions).toEqual(new Set([claimKey]))
    await flushAsyncTicks()

    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-bg')

    // A second navigation-free wake must not spawn again (one-pane/one-PTY).
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.wakeHibernatedAgentIfArmed()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('latches a navigation-free wake that lands before the hibernation kill arms the pane', async () => {
    // Race (#7906): the edge-triggered wake can land after the sleeping record but before the kill sets hibernatedWakePtyId; without a latch it'd be dropped, leaving a frozen terminal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-race' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
      dispose: () => void
    }
    await flushAsyncTicks()
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')

    // Wake arrives mid-kill: nothing is armed yet, but the pane must claim the session (suppressing the generic resume) and latch the request.
    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-race'
    expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
    const claimedProviderSessions = new Set<string>()
    expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
    expect(claimedProviderSessions).toEqual(new Set([claimKey]))
    const connectCallsBeforeExit = transport.connect.mock.calls.length

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // Arming consumed the latched wake — the --resume spawned with no reveal and no second wake event.
    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-race')
  })

  it('keeps an in-place provider claim until the replacement PTY spawn settles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-inflight' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      deps as never
    ) as unknown as {
      wakeHibernatedAgentIfArmed: () => string | null
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    const deferredSpawn = createDeferred<unknown>()
    transport.connect.mockImplementationOnce(() => deferredSpawn.promise)

    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-inflight'
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    const connectCallsAfterFirstWake = transport.connect.mock.calls.length
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFirstWake)

    deferredSpawn.resolve('pty-resumed')
    await flushAsyncTicks()
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('re-arms the exact hibernation target after a replacement spawn fails', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-retry' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      }) as never
    ) as unknown as { wakeHibernatedAgentIfArmed: () => string | null }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    transport.connect.mockRejectedValueOnce(new Error('transient spawn failure'))

    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-retry'
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    await flushAsyncTicks(20)
    const connectCallsAfterFailure = transport.connect.mock.calls.length

    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFailure + 1)
  })

  it('does not latch a stale sleeping record beside an unsuppressed live PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-stale' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    ) as unknown as {
      wakeHibernatedAgentIfArmed: () => string | null
    }
    await flushAsyncTicks()

    expect(binding.wakeHibernatedAgentIfArmed()).toBeNull()
  })

  it('auto-resumes a hibernated pane when its kill lands after the pane is already revealed', async () => {
    // Race: reveal's noteVisibilityResume runs before onExit arms the wake, so the arm-time foreground check must resume the pane instead of stranding a disarmed-but-dead frame.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: true }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-2' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    // The deferred connect attached this transport to the persisted tab PTY, so the kill's exit must carry that id for the wake guard's same-pty check.
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // No second reveal was needed: the foreground pane resumed its recorded session directly from the arm-time wake.
    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-2')

    // Still one-shot: a later reveal must not spawn again.
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('invalidates the hibernation wake when another flow rebinds the pane before reveal', async () => {
    // Why: intentional restarts share hibernation's exit suppression; a rebind while hidden owns the pane, so the armed wake must be discarded on reveal — permanently, not revived by a later death.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-3' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // Another flow rebinds the pane to a fresh PTY while it is still hidden.
    transport.getPtyId.mockReturnValue('pty-restarted')
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    // The rebound pane keeps its own session: no wake-driven resume spawn.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    // The rebound PTY later dies without a new sleeping record; the stale wake must not fire on the next reveal.
    transport.getPtyId.mockReturnValue(null)
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
  })

  it('records hibernation activity from the core user-input signal, not synthetic onData replies', async () => {
    // Regression: xterm auto-replies share the onData stream with typing; recording them as input made the planner see "input after done" and never hibernate.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(2)
    let userInputListener: (() => void) | null = null
    const userInputDispose = vi.fn()
    ;(pane.terminal as unknown as { _core: unknown })._core = {
      coreService: {
        onUserInput: vi.fn((listener: () => void) => {
          userInputListener = listener
          return { dispose: userInputDispose }
        })
      }
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      dispose: () => void
    }
    await flushAsyncTicks()
    expect(userInputListener).toBeTypeOf('function')
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

    // A focus-out report forwarded to the PTY must not count as activity.
    sendTerminalInputThroughPane(pane, '\x1b[O')
    expect(mockStoreState.recordTerminalInput).not.toHaveBeenCalled()
    // The reply still reaches the shell; only the activity recording is gated.
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O')

    // Real user input fires the core signal and records activity.
    ;(userInputListener as unknown as () => void)()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)

    binding.dispose()
    expect(userInputDispose).toHaveBeenCalled()
  })

  it('falls back to onData hibernation recording when the core user-input signal is unavailable', async () => {
    // If an xterm upgrade removes the internal signal, activity recording must degrade to the historical onData behavior — never to no tracking at all.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(2)

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

    sendTerminalInputThroughPane(pane, 'x')
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)
  })
})
