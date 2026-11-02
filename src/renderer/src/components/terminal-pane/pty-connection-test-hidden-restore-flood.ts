import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps, type PaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'
import type { PtyModelRestoreReason } from '../../../../shared/pty-model-restore-marker'

// Shared visible-pane driver for the hidden-restore flood/unhide suites (STA-4869).

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

export const PTY_ID = 'pty-id'
export const BANNER_FRAGMENT = 'main recovery was unavailable'
// One char over HIDDEN_OUTPUT_RESTORE_PENDING_CHARS (512KB): the queue discards
// its whole backlog and latches overflow.
export const OVERFLOW_CHUNK = 'o'.repeat(512 * 1024 + 1)

export type MainSnapshot = {
  data: string
  cols: number
  rows: number
  seq: number
}

export function modelSnapshot(marker: string, seq: number): MainSnapshot {
  return { data: `${marker}\r\n`, cols: 120, rows: 40, seq }
}

export type PaneDrive = {
  pane: MockPane
  transport: MockTransport
  deps: PaneConnectionDeps
  disposable: { dispose: () => void }
  deliver: (data: string, seq: number) => void
  setVisible: (visible: boolean) => void
  writtenChunks: () => string[]
}

export function installHiddenRestoreFloodSuiteHooks(): void {
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
}

export async function connectVisiblePane(): Promise<PaneDrive> {
  const transport = createMockTransport(PTY_ID)
  const captured: {
    current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
  } = { current: null }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: true }
  })
  const disposable = await connectMockPanePty(pane, createManager(1), deps)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    pane,
    transport,
    deps,
    disposable,
    deliver: (data, seq) => captured.current?.(data, { seq, rawLength: data.length }),
    setVisible: (visible) => {
      deps.isVisibleRef.current = visible
    },
    writtenChunks: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

export async function announceMainDrop(
  markerSeq: number | undefined,
  hiddenDropEpisode?: number,
  reason: PtyModelRestoreReason = 'hidden-drop',
  ptyId = PTY_ID
): Promise<void> {
  const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
  _dispatchPtyModelRestoreNeededForTest({
    id: ptyId,
    reason,
    ...(markerSeq !== undefined ? { markerSeq } : {}),
    ...(hiddenDropEpisode !== undefined ? { hiddenDropEpisode } : {})
  })
}
