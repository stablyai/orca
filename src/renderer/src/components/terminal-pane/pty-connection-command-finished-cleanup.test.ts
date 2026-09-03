import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST_REPLAY_REATTACH_RESET } from '../../../../shared/terminal-mode-reset-profiles'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  createKeyboardEventTarget,
  keyEvent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
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

  it.each(['process', 'launch'] as const)(
    'does not let typed Droid input replace another live TUI %s identity',
    async (identitySource) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const ptyId = `pty-antigravity-${identitySource}-typed-droid`
      const tabId = `tab-antigravity-${identitySource}-typed-droid`
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({ tabId, isVisibleRef: { current: false } }) as never
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      if (identitySource === 'process') {
        mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
          agent: 'antigravity',
          shellForeground: false
        }
      } else {
        mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
          launchConfig: { agentArgs: '', agentEnv: {} },
          identity: { agentType: 'antigravity' }
        }
      }

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07')

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    }
  )

  it.each([
    ['SSH', 'ssh:conn@@pty-typed-droid', 'tab-ssh-typed-droid'],
    ['remote runtime', 'remote:web-env-1@@pty-typed-droid', 'tab-remote-typed-droid']
  ])(
    'does not persist typed command process evidence for %s panes',
    async (_label, ptyId, tabId) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({ tabId, isVisibleRef: { current: false } }) as never
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07\x1b]133;D;0\x07')

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(
        paneKey,
        expect.anything()
      )
    }
  )

  it('keeps Droid routing visible through command-finished foreground confirmation', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const getForegroundProcess = vi.mocked(window.api.pty.confirmForegroundProcess)
    getForegroundProcess.mockResolvedValue('droid')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-confirmation-window'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    const readsBeforeFinish = getForegroundProcess.mock.calls.length
    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(350)
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')

    expect(getForegroundProcess).toHaveBeenCalledTimes(readsBeforeFinish + 1)
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('retires pane launch routing after one fresh scan confirms shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-confirmed-shell'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350)
    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: true
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    // Why: `agentStatus:drop` deliberately preserves a live pane's per-pane caches, so a
    // process-confirmed agent exit must go through the reconcile route instead — otherwise a
    // surviving Claude latch resolves the pane's next event straight back to 'working' (STA-4612).
    expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
  })

  it('reconciles a pane that HAS a status row, whose own drop removes it first', async () => {
    // Why this shape: the sibling test above covers a pane with no row, where the deferred drop
    // early-returns and never touches the pane's accepted-status bookkeeping. That is not the
    // production case. A pane worth reconciling always HAS a row — and settling runs the drop
    // BEFORE the reconcile, so the reconcile must survive its own drop having already fired.
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    // Both imported after vi.resetModules() so they share pty-connection's module registry; a
    // static top-level import here is a DIFFERENT instance and the assertion goes vacuous.
    const { createTestStore } = await import('@/store/slices/store-test-helpers')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
    vi.mocked(window.api.agentStatus.reconcileEndedProcess).mockClear()
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-claude-row-confirmed-shell'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()

    // A real accepted status write, through the real slice, so the row carries whatever
    // bookkeeping the store stamps on an accepted write. `working` is the shape STA-4612 is about:
    // a latch is holding the pane open and the agent is about to exit out from under it.
    const realStore = createTestStore()
    realStore
      .getState()
      .setAgentStatus(paneKey, { state: 'working', prompt: 'ship it', agentType: 'claude' })
    const row = realStore.getState().agentStatusByPaneKey[paneKey]
    expect(row).toBeDefined()
    mockStoreState.agentStatusByPaneKey[paneKey] = row
    // The real dismissal removes the row and runs the slice's own teardown; mirror both, or the
    // ordering this test exists to pin is never exercised.
    mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
      delete mockStoreState.agentStatusByPaneKey[key]
      realStore.getState().dropAgentStatus(key)
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
  })

  it('does NOT reconcile when the process check could not confirm a shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
    vi.mocked(window.api.agentStatus.reconcileEndedProcess).mockClear()
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-unconfirmed-shell'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    // Run the whole confirm ladder. At 350ms the unavailable branch has not settled yet, so
    // asserting there proves nothing — it would pass just as happily if this path DID tear the
    // pane down a moment later.
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    // The unavailable branch really ran: it publishes an unproven foreground before settling.
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: false
    })
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
  })

  it('disarms stale TUI modes in the emulator after a confirmed return to shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('bash')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-stale-mode-disarm'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }

    // A SIGKILLed agent emits no mode teardown; only the shell's next prompt
    // mark arrives. The bare 133;D must not disarm yet — the foreground read
    // has not confirmed the agent is gone.
    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    expect(writes.some((w) => w.includes(POST_REPLAY_REATTACH_RESET))).toBe(false)

    await vi.advanceTimersByTimeAsync(350)
    await flushAsyncTicks()

    const disarm = writes.find((w) => w.includes(POST_REPLAY_REATTACH_RESET))
    expect(disarm).toBeDefined()
    // The live shell re-arms bracketed paste at its prompt before the disarm
    // fires; the reset must not strip it.
    expect(disarm).not.toContain('\x1b[?2004l')
  })

  it('keeps armed modes while the agent still owns the foreground after a leaked 133;D', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-stale-mode-live-agent'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }

    // A full-screen agent's nested command shell leaks a 133;D onto the main
    // PTY; the confirming read republishes the live agent, so its armed
    // mouse/kitty modes must survive untouched.
    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    expect(writes.some((w) => w.includes(POST_REPLAY_REATTACH_RESET))).toBe(false)
  })

  it('retires stale routing after unavailable command-finish reads without asserting shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-unavailable-finish'
    const tabId = 'tab-droid-unavailable-finish'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey(tabId, LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId, isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('cancels deferred cleanup on a new command and retires identity at its later shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-superseded-confirmation'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    dataCallbackRef.current?.('\x1b]133;C\x07')
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('pins interrupt inference before acknowledged input and command exit cleanup', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    const writeAccepted = createDeferred<boolean>()
    transport.sendInputAccepted = vi.fn(() => writeAccepted.promise)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transport.attach.mockImplementation(({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'done',
        prompt: 'stop quickly',
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        terminalTitle: 'Codex',
        interrupted: true,
        stateHistory: [
          {
            state: 'working',
            prompt: 'stop quickly',
            startedAt: 900
          }
        ]
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'Escape' }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    delete mockStoreState.agentStatusByPaneKey[paneKey]
    writeAccepted.resolve(true)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop quickly',
      baselineAgentType: 'codex',
      intent: 'plain-escape'
    })
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('drops the command-finished status when pending interrupt inference is rejected', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(false)
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
  })
})
