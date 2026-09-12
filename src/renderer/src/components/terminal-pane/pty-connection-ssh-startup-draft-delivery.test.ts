import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import { beginAgentStartupDeliveryAttempt } from '@/lib/agent-startup-delayed-delivery'
import { flushAsyncTicks } from './pty-connection-test-async'
import { VISIBLE_PTY_SETTLE_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
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

  it('delegates ordinary SSH startup delivery to the provider without a renderer duplicate', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-id')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-ssh-1'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
      sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
    }

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup: { command: "claude 'say test'" } }) as never
    )
    await flushAsyncTicks()
    capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')

    expect(createdTransportOptions[0]).toEqual(
      expect.objectContaining({
        command: "claude 'say test'",
        commandDelivery: 'provider',
        startupCommandDelivery: 'shell-ready'
      })
    )
    expect(transport.sendInput).not.toHaveBeenCalledWith("claude 'say test'\r")
  })

  it('keeps the 8s fallback after a provider-owned non-Codex startup succeeds', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-droid')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-ssh-droid'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
      sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
    }
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
    const prompt = 'Review the linked work item'

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: 'droid',
          launchAgent: 'droid',
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'launch-token-ssh',
          draftPrompt: prompt
        }
      }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(7900)
    expect(transport.sendInputAccepted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    await flushAsyncTicks()

    expect(createdTransportOptions[0]?.commandDelivery).toBe('provider')
    expect(transport.sendInput).not.toHaveBeenCalledWith('droid\r')
    expect(transport.sendInputAccepted).toHaveBeenCalledWith(`\x1b[200~${prompt}\x1b[201~`)
  })

  it('waits past 8s for a cold Codex composer and preserves input ordering', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-codex')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-codex'
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchAgent: 'codex',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchToken: 'launch-token-1',
        draftPrompt: 'https://github.com/stablyai/orca/issues/42'
      }
    })
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

    connectPanePty(pane as never, manager as never, deps as never)
    await vi.advanceTimersByTimeAsync(VISIBLE_PTY_SETTLE_MS)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    // A focused xterm emits CSI I after Codex enables focus reporting; the startup draft must reuse the same transport instead of racing a direct IPC.
    ;(
      pane.terminal.onData as unknown as {
        mock: { calls: [(data: string) => void][] }
      }
    ).mock.calls[0]?.[0]('\x1b[I')
    ;(
      pane.terminal.onData as unknown as {
        mock: { calls: [(data: string) => void][] }
      }
    ).mock.calls[0]?.[0]('USER_DRAFT')
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(transport.sendInputAccepted).not.toHaveBeenCalled()
    capturedDataCallback.current?.('\x1b[?2004h\x1b[2K› ')
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith(
      '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~'
    )
    expect(transport.sendInput.mock.calls.map(([data]) => data)).toEqual([
      '\x1b[I',
      'USER_DRAFT',
      '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~'
    ])
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledOnce()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
  })

  it('keeps startup draft ownership while deferred connect waits through setup', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { beginAgentStartupDeliveryAttempt: claimStartupDelivery } =
      await import('@/lib/agent-startup-delayed-delivery')

    const deferredFrames: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      deferredFrames.push(callback)
      return 1
    })
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-codex')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-codex'
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'wait-for-setup-then-codex',
        launchAgent: 'codex',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchToken: 'launch-token-setup',
        draftPrompt: 'Linked Linear issue: STA-905'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const sidecarClaimed = claimStartupDelivery({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      launchToken: 'launch-token-setup'
    })
    expect(sidecarClaimed).toBe(false)

    let frameCount = 0
    while (deferredFrames.length > 0 && transport.connect.mock.calls.length === 0) {
      if (frameCount >= 20) {
        throw new Error('startup did not connect after the deferred setup handoff')
      }
      frameCount += 1
      deferredFrames.shift()?.(frameCount * 16)
    }
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()
    capturedDataCallback.current?.('\x1b[?2004hWaiting for setup to finish...')
    expect(transport.sendInputAccepted).not.toHaveBeenCalled()

    capturedDataCallback.current?.('\x1b[?2004h\x1b[2K› ')
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(transport.sendInputAccepted).toHaveBeenCalledWith(
      '\x1b[200~Linked Linear issue: STA-905\x1b[201~'
    )
  })

  it('releases startup draft delivery when disposed before deferred connect starts', async () => {
    const { connectPanePty } = await import('./pty-connection')
    globalThis.requestAnimationFrame = vi.fn(() => 1)
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: 'codex',
          launchAgent: 'codex',
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'launch-token-1',
          draftPrompt: 'https://github.com/stablyai/orca/issues/42'
        }
      }) as never
    )

    binding.dispose()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(
      beginAgentStartupDeliveryAttempt({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        launchToken: 'launch-token-1'
      })
    ).toBe(true)
  })

  it('does not fall back to renderer delivery when provider-owned SSH output has no marker', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('fish prompt> ')

      expect(transport.sendInput).not.toHaveBeenCalled()
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(createdTransportOptions[0]?.commandDelivery).toBe('provider')
      expect(transport.sendInput).not.toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('does not duplicate a quiet provider-owned SSH startup command', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()
      expect(transport.sendInput).not.toHaveBeenCalled()

      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(createdTransportOptions[0]?.commandDelivery).toBe('provider')
      expect(transport.sendInput).not.toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('uses provider delivery for SSH Codex native prefill commands without an explicit hint', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: { command: "codex --prefill 'linked issue context'" }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(createdTransportOptions[0]?.commandDelivery).toBe('provider')
      expect(transport.sendInput).not.toHaveBeenCalledWith(
        "codex --prefill 'linked issue context'\r"
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('keeps sequenced SSH startup wrappers provider-owned', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const wrapperCommand = 'bash -lc wait-for-setup-wrapper'
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: wrapperCommand,
          env: {
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --prefill 'linked issue context'"
          }
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(createdTransportOptions[0]?.commandDelivery).toBe('provider')
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${wrapperCommand}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
