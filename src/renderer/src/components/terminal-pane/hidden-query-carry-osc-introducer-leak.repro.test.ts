import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { flushAsyncTicks, writeHeadlessTerminal } from './pty-connection-test-async'
import {
  createManager,
  createMockTransport,
  createPane,
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

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

// Why: a hidden carry ending mid-CSI must not swallow the next chunk's `ESC ]` (#31410).
const HIDDEN_STRAGGLER_ENDING_MID_SGR = '\x1b[?2026h\x1b[H\x1b[38;2;177;1'
const CLAUDE_PALETTE_RESET = '\x1b]104;255\x07'
const PROMPT_SNAPSHOT = { data: '\x1b[H❯ ', cols: 120, rows: 40, seq: 1000 }

describe('hidden query carry vs a following OSC', () => {
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

  it('does not paint an OSC payload after the reveal restore when a hidden chunk ended mid-CSI', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const dataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
    getMainBufferSnapshot.mockResolvedValue(PROMPT_SNAPSHOT)

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      isVisibleRef,
      startup: { command: 'claude' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [pane, createManager(1), deps] as unknown as Parameters<typeof connectPanePty>
    const binding = connectPanePty(...args)
    const rendered = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
    try {
      await flushAsyncTicks(6)

      dataCallback.current?.(HIDDEN_STRAGGLER_ENDING_MID_SGR, {
        seq: 1000,
        rawLength: HIDDEN_STRAGGLER_ENDING_MID_SGR.length
      })
      isVisibleRef.current = true
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'unhide', markerSeq: 1000 })
      await flushAsyncTicks(40)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      dataCallback.current?.(CLAUDE_PALETTE_RESET, {
        seq: 1000 + CLAUDE_PALETTE_RESET.length,
        rawLength: CLAUDE_PALETTE_RESET.length
      })
      await flushAsyncTicks(40)

      const writes = pane.terminal.write.mock.calls.map(([data]) => data).join('')
      await writeHeadlessTerminal(rendered, writes)
      const promptLine = rendered.buffer.active.getLine(0)?.translateToString(true)
      expect(promptLine).toBe('❯ ')
    } finally {
      rendered.dispose()
      binding.dispose()
    }
  })
})
