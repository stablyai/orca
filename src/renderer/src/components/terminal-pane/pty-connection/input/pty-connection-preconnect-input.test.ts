import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectPanePty } from '../connect-pane-pty'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
  leafIdForPane,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import { clearWorktreeSleepIntent, markWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

const {
  notifyCodexPaneBoundForStaleSweep,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo
} = vi.hoisted(() => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('../../../../../../shared/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: false
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store/index', () => ({
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
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('../../pty-transport/ipc/pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

function connectPlainPane(
  overrides: Record<string, unknown> = {}
): ReturnType<typeof connectPanePty> {
  const connectArgs = [
    createPane(1),
    createManager(1),
    buildPaneConnectionDeps(() => mockStoreState, overrides)
  ]
  bindPaneAgentTitleMocks(connectArgs[2], agentTitleMocks)

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
  return connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
}

describe('connectPanePty pre-connect input', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    clearWorktreeSleepIntent('wt-1')
    await restoreTerminalTestGlobals()
  })

  it('stops releasing held keys once a resume source lands before the first bind', async () => {
    transportFactoryQueue.push(createMockTransport())

    const binding = connectPlainPane()
    const release = createdTransportOptions[0]?.releasePreconnectInput
    expect(typeof release).toBe('function')
    expect(typeof release === 'function' && release()).toBe(true)

    const paneKey = makePaneKey('tab-1', leafIdForPane(1))
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: '',
      agentType: 'claude',
      paneKey,
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'session-1' }
    }

    expect(typeof release === 'function' && release()).toBe(false)
    binding.dispose()
  })

  // Why: a split's held keys flushed ahead of a resume would run in the shell before it.
  it('stops releasing a deferred split’s held keys once startup work appears', async () => {
    transportFactoryQueue.push(createMockTransport())

    const binding = connectPlainPane({ cwdPromise: new Promise<string>(() => {}) })
    const release = createdTransportOptions[0]?.releasePreconnectInput
    const paneKey = makePaneKey('tab-1', leafIdForPane(1))
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    }

    expect(typeof release === 'function' && release()).toBe(false)
    binding.dispose()
  })

  it('keeps a brand-new pane’s typing for the terminal it creates, but not a restored pane’s', async () => {
    transportFactoryQueue.push(createMockTransport(), createMockTransport())
    mockStoreState.terminalLayoutsByTabId = {}

    const fresh = connectPlainPane()
    const restored = connectPlainPane({
      restoredLeafId: leafIdForPane(1),
      restoredPtyIdByLeafId: { [leafIdForPane(1)]: 'remote:env-1@@terminal-1' }
    })

    const keepFresh = createdTransportOptions[0]?.keepTypeAheadForNewTerminal
    const keepRestored = createdTransportOptions[1]?.keepTypeAheadForNewTerminal
    expect(typeof keepFresh === 'function' && keepFresh()).toBe(true)
    expect(typeof keepRestored === 'function' && keepRestored()).toBe(false)
    fresh.dispose()
    restored.dispose()
  })

  // Why: a cleared binding can still replay saved history into the pane.
  it('stops keeping a new pane’s typing once replayed history shows in it', async () => {
    transportFactoryQueue.push(createMockTransport())
    mockStoreState.terminalLayoutsByTabId = {}
    const pane = createPane(1)
    const connectArgs = [pane, createManager(1), buildPaneConnectionDeps(() => mockStoreState)]
    const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

    bindPaneAgentTitleMocks(connectArgs[2], agentTitleMocks2)

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane fixtures implement the members connectPanePty touches.
    const binding = connectPanePty(...(connectArgs as unknown as Parameters<typeof connectPanePty>))
    const keep = createdTransportOptions[0]?.keepTypeAheadForNewTerminal
    expect(typeof keep === 'function' && keep()).toBe(true)

    // The fresh create's own prompt and leaf binding count only before it starts, never at bind.
    pane.terminal.buffer.active.baseY = 12
    expect(typeof keep === 'function' && keep('connect')).toBe(false)
    expect(typeof keep === 'function' && keep('bind')).toBe(true)
    // Replayed history (checked at bind too) is covered through the real restore path in
    // pty-connection-remote-new-terminal-typeahead.test.ts.
    binding.dispose()
  })

  it('drops keys typed into a deliberately slept pane instead of replaying them on wake', async () => {
    markWorktreeSleepIntent('wt-1')
    const transport = Object.assign(createMockTransport(), { abandonPreconnectInput: vi.fn() })
    transportFactoryQueue.push(transport)

    const binding = connectPlainPane()
    await flushAsyncTicks(20)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.abandonPreconnectInput).toHaveBeenCalledOnce()
    binding.dispose()
  })
})
