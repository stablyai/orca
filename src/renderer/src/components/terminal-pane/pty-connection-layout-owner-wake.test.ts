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
import {
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from './pty-connection-test-main-pane-start-fixtures'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

const mocks = vi.hoisted(() => ({ wake: vi.fn() }))

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
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
    ;(await mainLayoutApplyTransport()).reset()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  // Main's start of the revealed pane is its wake: the window records none of its own.
  it('asks main to start the revealed pane alone, and records no wake itself', async () => {
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
    const args = mockPanePtyArgs(createPane(2), createManager(1), deps)
    // Main's real wake must find the pane still sleeping: the window's record drop follows it.
    let recordHeldAtWake: boolean | undefined
    mocks.wake.mockImplementation(() => {
      recordHeldAtWake = paneKey in mockStoreState.sleepingAgentSessionsByPaneKey
    })
    await mainStartsPaneAs({
      ptyId: 'pty-main',
      bind: bindsPaneInStore(() => mockStoreState, 'tab-1', leafIdForPane(2))
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

    // The revealed pane alone asks main to start it, then attaches to main's terminal.
    await expectWindowStartAskedMain(transport, paneKey, mockStoreState)
    expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toEqual([
      expect.objectContaining({ paneKey })
    ])
    expect(transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
    )
    expect(mocks.wake).not.toHaveBeenCalled()
    expect(recordHeldAtWake).toBeUndefined()
    // Main keeps the pane's record; the other pane's record is untouched.
    expect(mockStoreState.sleepingAgentSessionsByPaneKey).toHaveProperty(paneKey)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey).toHaveProperty(otherPaneKey)
  })
})
