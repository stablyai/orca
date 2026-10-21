import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { flushAsyncTicks } from './pty-connection-test-async'
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

const mocks = vi.hoisted(() => ({ wake: vi.fn() }))

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/store/terminals/terminal-sleep-layout-owner', () => ({
  recordPaneWakeThroughLayoutOwner: mocks.wake
}))

function sleepingRecord(paneKey: string, id: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: 'test prompt',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
}

describe('wake through main in a layout-owner build', () => {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => createdTransportOptions,
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('records the wake of the revealed pane alone, once its agent resumed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const paneKey = `tab-1:${leafIdForPane(2)}`
    const otherPaneKey = `tab-1:${leafIdForPane(3)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = sleepingRecord(paneKey, 'sess-shown')
    mockStoreState.sleepingAgentSessionsByPaneKey[otherPaneKey] = sleepingRecord(
      otherPaneKey,
      'sess-other'
    )
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [createPane(2), createManager(1), deps] as unknown as Parameters<
      typeof connectPanePty
    >
    // Main's real wake must find the pane still sleeping: the window's record drop follows it.
    let recordHeldAtWake: boolean | undefined
    mocks.wake.mockImplementation(() => {
      recordHeldAtWake = paneKey in mockStoreState.sleepingAgentSessionsByPaneKey
    })
    const binding = connectPanePty(...args)
    await flushAsyncTicks()
    const onPtyExit = createdTransportOptions[0]?.onPtyExit
    if (typeof onPtyExit === 'function') {
      onPtyExit('tab-pty')
    }
    await flushAsyncTicks()
    // Hidden: the sleep holds until the pane is shown.
    expect(mocks.wake).not.toHaveBeenCalled()

    binding.noteVisibilityResume()
    await flushAsyncTicks()

    const resumeConnectOptions: { command?: string } | undefined =
      transport.connect.mock.calls.at(-1)?.[0]
    expect(resumeConnectOptions?.command).toContain('sess-shown')
    expect(mocks.wake).toHaveBeenCalledTimes(1)
    expect(mocks.wake).toHaveBeenCalledWith(expect.anything(), 'wt-1', paneKey)
    expect(recordHeldAtWake).toBe(true)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey).not.toHaveProperty(paneKey)
  })
})
