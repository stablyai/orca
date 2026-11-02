// Wait for main’s start and attach to its terminal; expose start failures without spawning a second terminal.
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  leafIdForPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
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

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const TAB = 'tab-main-start'
const PANE_KEY = `${TAB}:${leafIdForPane(1)}`

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

function setStore(patch: Partial<StoreState>): void {
  mockStoreState = { ...mockStoreState, ...patch }
  for (const listener of storeSubscribers) {
    listener(mockStoreState)
  }
}

/** Main's frame binding the pane to `ptyId`, as the store shows it. */
function bindLeaf1(ptyId: string): void {
  bindsPaneInStore(() => mockStoreState, TAB, leafIdForPane(1))(ptyId)
}

/** Main's start: the frame binds the pane and clears its start status, as main's does. */
function startLeaf1(ptyId: string): void {
  bindLeaf1(ptyId)
  mockStoreState = { ...mockStoreState, terminalPaneStartsByPaneKey: {} }
}

async function connectWithStart(start: TerminalPaneStart | undefined) {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport()
  transportFactoryQueue.push(transport)
  setStore({
    tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: null }] },
    terminalPaneStartsByPaneKey: start ? { [PANE_KEY]: start } : {}
  })
  const deps = buildPaneConnectionDeps(() => mockStoreState, { tabId: TAB })
  const args = mockPanePtyArgs(createPane(1), createManager(1), deps)
  connectPanePty(...args)
  await flushAsyncTicks()
  return { transport, deps }
}

describe('a pane main is starting a terminal for', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => [],
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

  it('starts nothing while main starts it, then attaches to main’s terminal', async () => {
    const { transport } = await connectWithStart({ status: 'starting' })
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()

    // Main's start ends as the pane binds to main's terminal.
    const leafId = leafIdForPane(1)
    setStore({
      tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: 'pty-main' }] },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-main' }
        }
      },
      terminalPaneStartsByPaneKey: {}
    })
    await flushAsyncTicks()

    // It attaches to main's terminal at the pane's own grid, and starts none of its own.
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-main', cols: 120, rows: 40 })
    )
  })

  it('attaches a split pane to the terminal main bound it to, not its tab’s', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const newLeaf = leafIdForPane(2)
    setStore({
      tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: 'pty-source' }] },
      terminalPaneStartsByPaneKey: { [`${TAB}:${newLeaf}`]: { status: 'starting' } }
    })
    // The source pane already shows the tab's terminal.
    const source = createMockTransport('pty-source')
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      tabId: TAB,
      paneTransportsRef: { current: new Map([[1, source]]) }
    })
    const args = mockPanePtyArgs(createPane(2), createManager(2), deps)
    connectPanePty(...args)
    await flushAsyncTicks()
    expect(transport.connect).not.toHaveBeenCalled()

    setStore({
      terminalLayoutsByTabId: {
        [TAB]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: leafIdForPane(1) },
            second: { type: 'leaf', leafId: newLeaf }
          },
          activeLeafId: newLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafIdForPane(1)]: 'pty-source', [newLeaf]: 'pty-split' }
        }
      },
      terminalPaneStartsByPaneKey: {}
    })
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-split' })
    )
  })

  it('shows why a failed start failed and starts nothing', async () => {
    const { transport, deps } = await connectWithStart({
      status: 'failed',
      reason: 'agent runtime needs repair'
    })

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      1,
      'The terminal could not start: agent runtime needs repair'
    )
  })

  it('asks main to start a sleeping pane, then attaches to the terminal main binds', async () => {
    await mainStartsPaneAs({ ptyId: 'pty-main', bind: startLeaf1 })
    const { transport } = await connectWithStart({ status: 'sleeping' })

    await expectWindowStartAskedMain(transport, PANE_KEY)
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
    )
  })

  it('waits on a resuming pane, then attaches to the terminal main binds', async () => {
    const { transport } = await connectWithStart({ status: 'resuming' })
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()

    bindLeaf1('pty-main')
    setStore({ terminalPaneStartsByPaneKey: {} })
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-main', attachOnlyView: true })
    )
    expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toEqual([])
  })

  it("connects a held pane as today, so main's refusal holds it", async () => {
    const { transport } = await connectWithStart({ status: 'held' })

    expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
    expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toEqual([])
  })

  it('starts a pane with no start from main as before', async () => {
    const { transport } = await connectWithStart(undefined)

    expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
  })
})
