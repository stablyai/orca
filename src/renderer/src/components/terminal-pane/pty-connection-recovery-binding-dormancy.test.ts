import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  SECOND_WRAPPER_RETRY_MS,
  VISIBLE_PTY_SETTLE_MS,
  WRAPPER_RESOLVE_RETRY_MS
} from './pty-connection-test-constants'
import {
  LEAF_1,
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

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

const PANE_KEY = makePaneKey('tab-1', LEAF_1)
const RECOVERY_PANE_KEY = makePaneKey('tab-2', LEAF_2)

function makeRecord(overrides: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRecoveryRecord(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return makeRecord({
    paneKey,
    tabId,
    origin: 'recovery',
    recovery: { importKey: 'import-1', sourcePaneKey: 'src-tab:src-leaf' }
  })
}

function queueColdRestoreTransport(): MockTransport {
  const transport = createMockTransport('fresh-pty')
  transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
    sessionId
      ? { id: 'fresh-pty', coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' } }
      : 'fresh-pty'
  )
  transportFactoryQueue.push(transport)
  return transport
}

async function connectColdRestoredPane(): Promise<{ sampleForegroundAgentOnFocus: () => void }> {
  const { connectPanePty } = await import('./pty-connection')
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
  const args = [createPane(1), createManager(1), deps] as unknown as Parameters<
    typeof connectPanePty
  >
  const binding = connectPanePty(...args)
  await vi.advanceTimersByTimeAsync(100)
  await flushAsyncTicks(20)
  return binding
}

describe('connectPanePty dormant recovery bindings', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('keeps an imported binding when focus confirms the plain shell it left behind', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')
    const record = makeRecoveryRecord(PANE_KEY, 'tab-1')
    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty', launchAgent: 'claude' }]
    }
    mockStoreState.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: record }
    const transport = queueColdRestoreTransport()

    const binding = await connectColdRestoredPane()
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('resume') })
    )

    binding.sampleForegroundAgentOnFocus()
    await vi.advanceTimersByTimeAsync(
      VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
    )
    await flushAsyncTicks(20)

    expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(PANE_KEY, {
      agent: null,
      shellForeground: true
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })

  it('keeps an imported binding when a local record for the same session is consumed', async () => {
    const localRecord = makeRecord({ origin: 'quit' })
    const recoveryRecord = makeRecoveryRecord(RECOVERY_PANE_KEY, 'tab-2')
    mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }] }
    mockStoreState.sleepingAgentSessionsByPaneKey = {
      [PANE_KEY]: localRecord,
      [RECOVERY_PANE_KEY]: recoveryRecord
    }
    const transport = queueColdRestoreTransport()

    await connectColdRestoredPane()

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('claude-session-1') })
    )
    expect(mockStoreState.sleepingAgentSessionsByPaneKey).toEqual({
      [RECOVERY_PANE_KEY]: recoveryRecord
    })
  })
})
