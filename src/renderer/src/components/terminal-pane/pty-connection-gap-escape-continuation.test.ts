import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, renderHeadlessBuffer } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import type { PtyDataMeta } from './pty-dispatcher'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { connectMockPanePty } from './pty-connection-test-connect-mock-pane'

// #33766: a snapshot seq can cut a queued chunk mid-escape; xterm must not print the escape's tail as text.

const { scheduleRuntimeGraphSync, shouldSeedCacheTimerOnInitialTitle } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false)
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

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

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))

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

vi.mock('./pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

const PTY_ID = 'pty-id'
// Overflow the 2MB client queue so reveal repaints from main's snapshot.
const HIDDEN_FLOOD = 'x'.repeat(2 * 1024 * 1024 + 1)
// Claude Code's DEC 2026 frame start, split after ESC [ by the gap.
const RESUMED = '?2026h> prompt'
const TAIL = '2026h'

async function connectLocalPane(visible: boolean) {
  const transport = createMockTransport(PTY_ID)
  const captured: { current: ((data: string, meta?: PtyDataMeta) => void) | null } = {
    current: null
  }
  transport.connect.mockImplementation(async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
    captured.current = callbacks?.onData ?? null
    return PTY_ID
  })
  transportFactoryQueue.push(transport)
  const pane = createPane(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef: { current: visible }
  })
  const disposable = await connectMockPanePty(pane, createManager(1), deps)
  await flushAsyncTicks(6)
  expect(captured.current).not.toBeNull()
  return {
    disposable,
    deliver: (data: string, meta: PtyDataMeta) => captured.current?.(data, meta),
    setVisible: (next: boolean) => {
      deps.isVisibleRef.current = next
    },
    written: () => pane.terminal.write.mock.calls.map(([data]) => String(data))
  }
}

async function screenOf(chunks: string[]): Promise<string> {
  return (await renderHeadlessBuffer(chunks, 120, 8)).join('\n')
}

describe('snapshot cut inside an escape (#33766)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function revealAfterCut(pendingEscapeTailAnsi: string | undefined): Promise<string> {
    const frame = `\x1b[${RESUMED}`
    // The snapshot's seq lands after the frame's ESC [.
    vi.mocked(window.api.pty.getMainBufferSnapshot).mockResolvedValue({
      data: 'history\r\n',
      cols: 120,
      rows: 40,
      seq: HIDDEN_FLOOD.length + 2,
      ...(pendingEscapeTailAnsi ? { pendingEscapeTailAnsi } : {})
    })
    const drive = await connectLocalPane(false)
    vi.useFakeTimers()
    drive.deliver(HIDDEN_FLOOD, { seq: HIDDEN_FLOOD.length, rawLength: HIDDEN_FLOOD.length })
    drive.setVisible(true)
    drive.deliver(frame, { seq: HIDDEN_FLOOD.length + frame.length, rawLength: frame.length })
    await vi.advanceTimersByTimeAsync(60_000)
    await flushAsyncTicks(20)
    drive.disposable.dispose()
    vi.useRealTimers()
    return screenOf(drive.written())
  }

  it('completes the escape from the cut chunk when the snapshot re-arms none', async () => {
    const screen = await revealAfterCut(undefined)
    expect({ prompt: screen.includes('> prompt'), tail: screen.includes(TAIL) }).toEqual({
      prompt: true,
      tail: false
    })
  })

  it('keeps the tail that finishes the escape the snapshot re-armed', async () => {
    const screen = await revealAfterCut('\x1b[')
    expect({ prompt: screen.includes('> prompt'), tail: screen.includes(TAIL) }).toEqual({
      prompt: true,
      tail: false
    })
  })
})
