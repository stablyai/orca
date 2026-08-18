import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { flushAsyncTicks, drainPendingTimeouts } from './pty-connection-test-async'
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

  it('does not send startup command via sendInput for local connections', async () => {
    // Why: the local PTY provider already writes the command via writeStartupCommandWhenShellReady; re-sending from the renderer would double it in the terminal.
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)

    // Local connection: no connectionId
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ startup: { command: "claude 'say test'" } })

    connectPanePty(pane as never, manager as never, deps as never)
    expect(capturedDataCallback.current).not.toBeNull()

    // Simulate PTY output (shell prompt arriving)
    capturedDataCallback.current?.('(base) user@host $ ')

    // Even after the debounce, the renderer must not inject the command (main already wrote it via writeStartupCommandWhenShellReady).
    expect(transport.sendInput).not.toHaveBeenCalledWith(
      expect.stringContaining("claude 'say test'")
    )
  })

  it('seeds a working status for Command Code startup prompts after spawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const transport = createMockTransport(sshPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]])
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: "command-code --trust 'Fix the status'",
        initialAgentStatus: { agent: 'command-code', prompt: 'Fix the status' }
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.(sshPtyId)

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the status',
        agentType: 'command-code',
        // Why: Orca launched this agent, so the seed predates any provider signal (STA-4293).
        observation: expect.objectContaining({ origin: 'launch', kind: 'transition' })
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
  })

  it('seeds a working status from Command Code thinking output without a startup prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const sshPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const transport = createMockTransport(sshPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return sshPtyId
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [{ id: 'repo1', connectionId: 'ssh-a' }]
    mockStoreState.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code',
        // Why: read off the pane's own output, not a provider hook (STA-4293).
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
  })

  it('ignores delayed Command Code output after the leaf rebinds to another SSH host', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const oldPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const newPtyId = toAppSshPtyId('ssh-b', 'pty-command-code')
    const transport = createMockTransport(oldPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return oldPtyId
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [{ id: 'repo1', connectionId: 'ssh-a' }]
    mockStoreState.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup: { command: 'command-code --trust' } }) as never
    )
    await flushAsyncTicks()
    mockStoreState.setAgentStatus.mockClear()
    mockStoreState.ptyIdsByTabId = { 'tab-1': [oldPtyId, newPtyId] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: newPtyId }

    capturedDataCallback.current?.('❯ stale prompt\r\n\x1b[35m✻ Thinking...\x1b[0m')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('marks a Command Code no-tool turn done after the idle prompt settles', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ say hi\r\n✻ Thinking...')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    capturedDataCallback.current?.(
      '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
    )
    vi.advanceTimersByTime(1499)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    vi.advanceTimersByTime(1)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      prompt: 'say hi',
      agentType: 'command-code'
    })
  })

  it('keeps Command Code working when an active repaint follows the idle prompt before settle', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ Run a slow command\r\n✻ Thinking...')
    capturedDataCallback.current?.('\r\n❯ Ask your question...')
    vi.advanceTimersByTime(1000)
    capturedDataCallback.current?.('\r\n✧ Investigating... esc to interrupt')
    vi.advanceTimersByTime(500)

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'Run a slow command',
      agentType: 'command-code'
    })
  })

  it('does not downgrade a completed Command Code turn back to working from stale TUI output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    expect((mockStoreState.agentStatusByPaneKey[paneKey] as { state?: unknown })?.state).toBe(
      'done'
    )
  })

  it('starts a new Command Code turn after done when TUI output carries a different prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the green done state\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      {
        state: 'working',
        prompt: 'Fix the green done state',
        agentType: 'command-code',
        observation: expect.objectContaining({ origin: 'process', kind: 'transition' })
      },
      undefined,
      undefined,
      { connectionId: null }
    )
  })

  it('keeps SSH terminal-paste startup commands renderer-owned', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      pane.terminal.modes.bracketedPasteMode = true
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = 'cd packages\nbun run build\ncd ..'
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(createdTransportOptions[0]?.commandDelivery).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).toHaveBeenCalledWith(command)
      expect(transport.sendInput).toHaveBeenCalledWith('\r')
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('chunks large terminal-paste startup commands through the PTY before submitting', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      const writtenInput = transport.sendInput.mock.calls.map((call) => call[0])
      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(writtenInput.at(-1)).toBe('\r')
      expect(writtenInput.slice(0, -1).join('')).toBe(command)
      expect(writtenInput.slice(0, -1).length).toBeGreaterThan(1)
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('does not submit a terminal-paste startup command after the PTY changes mid-paste', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      let livePtyId = 'pty-local-paste'
      transport.getPtyId.mockImplementation(() => livePtyId)
      transport.sendInput.mockImplementation((data: string) => {
        if (data !== '\r') {
          livePtyId = 'pty-replaced'
        }
        return true
      })
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalledWith('\r')
      expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).not.toBe(command)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
