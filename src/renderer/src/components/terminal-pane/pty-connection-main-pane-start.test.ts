// Layout-owner build: a pane main is starting a terminal for never starts one of its own. It waits,
// then attaches to main's terminal; a start that failed shows why.
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

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

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

async function connectWithStart(start: TerminalPaneStart | undefined) {
  const { connectPanePty } = await import('./pty-connection')
  const transport = createMockTransport()
  transportFactoryQueue.push(transport)
  setStore({
    tabsByWorktree: { 'wt-1': [{ id: TAB, ptyId: null }] },
    terminalPaneStartsByPaneKey: start ? { [PANE_KEY]: start } : {}
  })
  const deps = buildPaneConnectionDeps(() => mockStoreState, { tabId: TAB })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
  const args = [createPane(1), createManager(1), deps] as unknown as Parameters<
    typeof connectPanePty
  >
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [createPane(2), createManager(2), deps] as unknown as Parameters<
      typeof connectPanePty
    >
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

  it.each(['sleeping', 'resuming', 'held'] as const)(
    'leaves a %s pane to its restore path, as before',
    async (status) => {
      const { transport } = await connectWithStart({ status })

      expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
    }
  )

  it('starts a pane with no start from main as before', async () => {
    const { transport } = await connectWithStart(undefined)

    expect(transport.connect.mock.calls.length + transport.attach.mock.calls.length).toBe(1)
  })
})
