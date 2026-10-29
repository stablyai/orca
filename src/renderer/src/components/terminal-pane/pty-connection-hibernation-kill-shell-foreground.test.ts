import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

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

// Why: useCallback must pass through; no test here renders React.
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

// Stub eager-buffer lookup to exercise live adoption without the IPC dispatcher.
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

// A hibernation kill ends the agent before the PTY, so the pane sees its own shell for a moment.
describe('shell showing through a hibernation kill', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function connectHibernatingPane(suppressExit: boolean): Promise<{
    finishCommand: () => void
    exitPty: () => void
    rebindPty: (id: string | null) => void
    paneKey: string
    record: SleepingAgentSessionRecord
  }> {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-hibernating'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const args = mockPanePtyArgs(
      createPane(1),
      createManager(1),
      createDeps({
        isVisibleRef: { current: false },
        consumeSuppressedPtyExit: vi.fn((id: string) => {
          const suppressed = mockStoreState.suppressedPtyExitIds[id] === true
          delete mockStoreState.suppressedPtyExitIds[id]
          return suppressed
        })
      })
    )
    connectPanePty(...args)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'claude' }
    }
    // Hibernation writes the wake record and suppresses the exit before it kills the PTY.
    const record: SleepingAgentSessionRecord = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernating' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = record
    if (suppressExit) {
      mockStoreState.suppressedPtyExitIds[ptyId] = true
    }
    return {
      paneKey,
      record,
      finishCommand: () => dataCallbackRef.current?.('\x1b]133;D;0\x07'),
      rebindPty: (id: string | null) => transport.getPtyId.mockReturnValue(id),
      exitPty: () => {
        const onPtyExit = createdTransportOptions[0]?.onPtyExit
        if (typeof onPtyExit === 'function') {
          onPtyExit(ptyId)
        }
      }
    }
  }

  it('keeps the wake record while the kill is in flight', async () => {
    const pane = await connectHibernatingPane(true)

    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.paneForegroundAgentByPaneKey[pane.paneKey]).toEqual({
      agent: null,
      shellForeground: true
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toMatchObject({
      providerSession: { id: 'sess-hibernating' }
    })
  })

  it.each(['pty-hibernating', null])(
    'preserves the wake record when a pending confirmation settles with PTY %s',
    async (boundPtyId) => {
      const pane = await connectHibernatingPane(true)
      const foreground = createDeferred<string | null>()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(foreground.promise)

      pane.finishCommand()
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledExactlyOnceWith(
        'pty-hibernating'
      )
      pane.exitPty()
      pane.rebindPty(boundPtyId)
      await flushAsyncTicks()
      expect(mockStoreState.suppressedPtyExitIds).toEqual({})
      foreground.resolve('zsh')
      await flushAsyncTicks()

      // A detached transport rejects the stale read; a retained binding reaches shell cleanup.
      expect(mockStoreState.paneForegroundAgentByPaneKey[pane.paneKey]?.shellForeground).toBe(
        boundPtyId === null ? undefined : true
      )
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toMatchObject({
        providerSession: { id: 'sess-hibernating' }
      })
    }
  )

  it('clears the record once another PTY is bound in place of the hibernated one', async () => {
    const pane = await connectHibernatingPane(true)

    pane.exitPty()
    await flushAsyncTicks()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    // A restart binds a new PTY without consuming the armed wake.
    pane.rebindPty('pty-restarted')
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
  })

  it('still clears a record beside a PTY that is not being hibernated', async () => {
    const pane = await connectHibernatingPane(false)

    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
  })

  it('does not protect a replacement record with the old wake target', async () => {
    const pane = await connectHibernatingPane(true)

    pane.exitPty()
    await flushAsyncTicks()
    mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey] = {
      ...pane.record,
      updatedAt: 2
    }
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
  })
})
