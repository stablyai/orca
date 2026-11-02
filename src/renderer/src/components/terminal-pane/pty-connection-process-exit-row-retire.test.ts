import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import type * as CoordinatorModule from './agent-completion-coordinator'
import type { AgentCompletionCoordinatorOptions } from './agent-completion-coordinator-types'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  leafIdForPane,
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

const {
  coordinatorOptionsByPaneKey,
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  coordinatorOptionsByPaneKey: new Map<string, AgentCompletionCoordinatorOptions>(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
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

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

// Why: lets a test deliver the monitor's confirmed exit without driving a remote host's verdict.
vi.mock('./agent-completion-coordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof CoordinatorModule>()
  return {
    ...actual,
    createAgentCompletionCoordinator: (options: AgentCompletionCoordinatorOptions) => {
      coordinatorOptionsByPaneKey.set(options.paneKey, options)
      return actual.createAgentCompletionCoordinator(options)
    }
  }
})

async function connectAgentPane(args: {
  ptyId: string
  tabId?: string
  paneId?: number
  visible?: boolean
}): Promise<{
  paneKey: string
  sendData: (data: string) => void
  confirmExit: (agent: TerminalAgent) => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
  const transport = createMockTransport(args.ptyId)
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
    dataCallbackRef.current = callbacks.onData ?? null
    return { id: args.ptyId }
  })
  transportFactoryQueue.push(transport)
  const tabId = args.tabId ?? 'tab-1'
  const paneId = args.paneId ?? 1
  const connectArgs = [
    createPane(paneId),
    createManager(paneId),
    buildPaneConnectionDeps(() => mockStoreState, {
      tabId,
      isVisibleRef: { current: args.visible ?? false }
    })
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
  connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
  await vi.advanceTimersByTimeAsync(20)
  await flushAsyncTicks()
  const paneKey = makePaneKey(tabId, leafIdForPane(paneId))
  return {
    paneKey,
    sendData: (data) => dataCallbackRef.current?.(data),
    confirmExit: (agent) =>
      coordinatorOptionsByPaneKey.get(paneKey)?.onForegroundAgentExited?.({
        agent,
        processName: agent
      })
  }
}

async function seedHookRow(
  paneKey: string,
  agentType: 'claude' | 'codex',
  state: 'working' | 'done' = 'done'
): Promise<AgentStatusEntry> {
  // Why the real slice: the row must carry the acceptedStatusSeq a real accepted hook stamps.
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const realStore = createTestStore()
  realStore.getState().setAgentStatus(paneKey, { state, prompt: 'ship it', agentType })
  const row = realStore.getState().agentStatusByPaneKey[paneKey]
  mockStoreState.agentStatusByPaneKey[paneKey] = row
  return row
}

function setHostCanVerifyOwner(answer: boolean | Promise<boolean>): void {
  window.api.agentStatus.hasVerifiableAgentProcess = vi.fn(() => Promise.resolve(answer))
}

describe('connectPanePty confirmed process exit retires the live agent row', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    coordinatorOptionsByPaneKey.clear()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
    mockStoreState.dropAgentStatus.mockImplementation((paneKey: string) => {
      delete mockStoreState.agentStatusByPaneKey[paneKey]
    })
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('drops the row and retires main latches when Claude exits in a pane without command marks', async () => {
    let foreground: string | null = 'claude'
    let children = true
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
    vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => children)
    const { paneKey } = await connectAgentPane({ ptyId: 'pty-cmd-claude', visible: true })
    await seedHookRow(paneKey, 'claude')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeDefined()

    // `/exit` in cmd.exe: the shell is back and no 133;D ever arrives.
    foreground = 'cmd.exe'
    children = false
    await vi.advanceTimersByTimeAsync(10_000)
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    // No `paneRemoved`: the pane outlived the agent, so main keeps the resume identity.
    expect(mockStoreState.dropAgentStatus.mock.calls).toEqual([[paneKey]])
    expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeUndefined()
  })

  it('retires a hook-identified row the foreground tracker never read', async () => {
    const { paneKey, confirmExit } = await connectAgentPane({ ptyId: 'pty-cmd-hook-only' })
    await seedHookRow(paneKey, 'codex', 'working')
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.agentEvidence).not.toBe(
      'process-read'
    )

    confirmExit('codex')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
  })

  it('leaves a pane with an armed command-finished drop to its own confirming read', async () => {
    vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(new Promise(() => {}))
    const { paneKey, sendData, confirmExit } = await connectAgentPane({ ptyId: 'pty-zsh-claude' })
    // A live hook icon makes the 133;D defer its drop behind a confirming read.
    await seedHookRow(paneKey, 'claude', 'working')
    sendData('\x1b]133;D;0\x07')

    confirmExit('claude')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeDefined()
  })

  it('leaves a remote pane to its execution host', async () => {
    const { paneKey, confirmExit } = await connectAgentPane({
      ptyId: toAppSshPtyId('conn-1', 'relay-pty-1')
    })
    await seedHookRow(paneKey, 'claude')

    confirmExit('claude')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
  })

  it('keeps the row when the host can verify the owner process itself', async () => {
    setHostCanVerifyOwner(true)
    const { paneKey, confirmExit } = await connectAgentPane({ ptyId: 'pty-mac-claude' })
    await seedHookRow(paneKey, 'claude')

    confirmExit('claude')
    await flushAsyncTicks()

    expect(window.api.agentStatus.hasVerifiableAgentProcess).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
  })

  it('keeps the row when the agent is relaunched before the exit settles', async () => {
    const hostAnswer = createDeferred<boolean>()
    setHostCanVerifyOwner(hostAnswer.promise)
    const { paneKey, confirmExit } = await connectAgentPane({ ptyId: 'pty-cmd-relaunch' })
    const exitedRow = await seedHookRow(paneKey, 'claude')

    confirmExit('claude')
    // The relaunched Claude's first hook lands while the host is still answering.
    vi.setSystemTime(Date.now() + 1_000)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      ...exitedRow,
      state: 'working',
      prompt: 'next session',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      acceptedStatusSeq: (exitedRow.acceptedStatusSeq ?? 0) + 1
    }
    hostAnswer.resolve(false)
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
  })

  it('keeps a row that belongs to a different agent', async () => {
    const { paneKey, confirmExit } = await connectAgentPane({ ptyId: 'pty-cmd-other-agent' })
    await seedHookRow(paneKey, 'codex')

    confirmExit('claude')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
  })

  it('retires only the split pane whose agent exited', async () => {
    const left = await connectAgentPane({ ptyId: 'pty-split-left', paneId: 1 })
    const right = await connectAgentPane({ ptyId: 'pty-split-right', paneId: 2 })
    await seedHookRow(left.paneKey, 'claude')
    await seedHookRow(right.paneKey, 'claude')

    left.confirmExit('claude')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus.mock.calls).toEqual([[left.paneKey]])
    expect(vi.mocked(window.api.agentStatus.reconcileEndedProcess).mock.calls).toEqual([
      [left.paneKey]
    ])
    expect(mockStoreState.agentStatusByPaneKey[right.paneKey]).toBeDefined()
  })
})
