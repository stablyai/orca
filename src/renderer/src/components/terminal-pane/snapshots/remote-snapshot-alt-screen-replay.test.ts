import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  flushAsyncTicks,
  writeHeadlessTerminal
} from '../pty-connection/test-fixtures/pty-connection-test-async'
import {
  terminalWriteText,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../pty-connection/test-fixtures/pty-connection-test-pane-fixtures'

import type { PtyReplayDataMeta } from '../pty-transport/pty-transport-types'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../pty-connection/test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../pty-connection/test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../pty-connection/test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection/test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../pty-connection/test-fixtures/pty-connection-test-connect-mock-pane'

const { scheduleRuntimeGraphSync, shouldSeedCacheTimerOnInitialTitle, toastInfo } = vi.hoisted(
  () => ({
    scheduleRuntimeGraphSync: vi.fn(),
    shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
    toastInfo: vi.fn()
  })
)

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({ scheduleRuntimeGraphSync }))

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

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } =
    await import('../pty-connection/test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../titles/cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('../pty-transport/ipc/pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

const COLS = 40
const ROWS = 6
// Live TUIs freeze normal history on both host and pane; start with matching pre-TUI setup output.
const NORMAL_LINES = [...Array.from({ length: 10 }, (_, i) => `SETUP-OUTPUT-${i}`), '$ claude']
const LIVE_PANE = `${NORMAL_LINES.join('\r\n')}\x1b[?1049h\x1b[2J\x1b[HOLD-AGENT-FRAME`
// Agent frames jump the cursor over cells they expect blank instead of writing spaces.
const AGENT_FRAME = '\x1b[H\x1b[2;1HNo\x1b[1Cnotice\x1b[1Ctoday'
const ENTER_AGENT_FRAME = `\x1b[0m\x1b[?1049h${AGENT_FRAME}`

// Remote image shapes: the normal buffer folded in, then the image enters alt itself.
// Pushes carry only the host's screen; requested snapshots also carry history.
function pushedImage(hostRows: number): string {
  return `${NORMAL_LINES.slice(-hostRows).join('\r\n')}${ENTER_AGENT_FRAME}`
}
// What the multiplexer hands the pane for a recovery push (its own screen clear first).
function recoveryPayload(hostRows: number): string {
  return `\x1b[?2026l\x1b[2J\x1b[3J\x1b[H${pushedImage(hostRows)}`
}

type PaneEvent = string | { cols: number; rows: number }

function bufferLines(term: Terminal, which: 'normal' | 'alternate'): string[] {
  const buffer = which === 'normal' ? term.buffer.normal : term.buffer.alternate
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  )
}

function viewport(term: Terminal, which: 'normal' | 'alternate'): string[] {
  return bufferLines(term, which).slice(-term.rows)
}

async function render(events: PaneEvent[], rows = ROWS): Promise<Terminal> {
  const term = new Terminal({ cols: COLS, rows, scrollback: 100, allowProposedApi: true })
  for (const event of events) {
    if (typeof event === 'string') {
      await writeHeadlessTerminal(term, event)
    } else {
      term.resize(event.cols, event.rows)
    }
  }
  return term
}

/** The live pane's own buffers carried through the drain's grid changes and nothing else. */
function untouchedPane(events: PaneEvent[]): Promise<Terminal> {
  return render([LIVE_PANE, ...events.filter((event) => typeof event !== 'string')])
}

describe('remote snapshot replay onto a live alt screen', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  /** The pane's writes and grid changes, in order, ending back at the pane's own grid. */
  async function drainOntoLiveAltScreen(
    data: string,
    meta: PtyReplayDataMeta,
    // 'alternate-queued': the TUI's ?1049h is still queued and parses with the first write.
    paneBuffer: 'normal' | 'alternate' | 'alternate-queued' = 'alternate'
  ): Promise<PaneEvent[]> {
    const { connectPanePty } = await import('../pty-connection/connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )
    const transport = createMockTransport('agent-pty')
    const replay: { current: ConnectCallbacks['onReplayData'] | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replay.current = callbacks.onReplayData ?? null
      return 'agent-pty'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const events: PaneEvent[] = []
    const parseCallbacks: (() => void)[] = []
    pane.terminal.write.mockImplementation((chunk: string | Uint8Array, callback?: () => void) => {
      chunk = terminalWriteText(chunk)
      if (chunk.length > 0) {
        events.push(chunk)
      }
      if (callback) {
        parseCallbacks.push(() => {
          pane.terminal.buffer.active.type = paneBuffer === 'normal' ? 'normal' : 'alternate'
          callback()
        })
      }
    })
    pane.terminal.resize.mockImplementation((cols: number, rows: number) => {
      pane.terminal.cols = cols
      pane.terminal.rows = rows
      events.push({ cols, rows })
    })
    const deps = buildPaneConnectionDeps(() => mockStoreState)
    const binding = connectPanePty(
      ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks))
    )
    await flushAsyncTicks(8)
    pane.terminal.cols = COLS
    pane.terminal.rows = ROWS
    pane.terminal.buffer.active.type = paneBuffer === 'alternate' ? 'alternate' : 'normal'
    replay.current?.(data, meta)
    for (let index = 0; index < 12; index += 1) {
      await flushAsyncTicks(4)
      parseCallbacks.shift()?.()
    }
    await flushAsyncTicks(8)
    binding.dispose()
    expect(
      events.some((event) => typeof event === 'string' && event.length > 0 && data.endsWith(event))
    ).toBe(true)
    return [...events, { cols: COLS, rows: ROWS }]
  }

  // Keep frozen normal history when a push repaints only the live alt frame, regardless of capture grid.
  it("keeps the pane's history when the host screen has another grid", async () => {
    const hostRows = 10
    const events = await drainOntoLiveAltScreen(recoveryPayload(hostRows), {
      carriesNormalBuffer: true,
      snapshotCols: COLS,
      snapshotRows: hostRows
    })
    const client = await render([LIVE_PANE, ...events])
    const untouched = await untouchedPane(events)
    const fresh = await render([pushedImage(hostRows), { cols: COLS, rows: ROWS }], hostRows)
    try {
      expect(viewport(client, 'alternate')).toEqual(viewport(fresh, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(untouched, 'normal'))
    } finally {
      client.dispose()
      untouched.dispose()
      fresh.dispose()
    }
  })

  // Wait for queued ?1049h before reading buffer type or normal image bytes could paint into the TUI.
  it('reads the pane buffer after a queued alt-screen entry parses', async () => {
    const client = await render([
      LIVE_PANE,
      ...(await drainOntoLiveAltScreen(
        recoveryPayload(ROWS),
        { carriesNormalBuffer: true, snapshotCols: COLS, snapshotRows: ROWS },
        'alternate-queued'
      ))
    ])
    const host = await render([LIVE_PANE])
    const fresh = await render([pushedImage(ROWS)])
    try {
      expect(viewport(client, 'alternate')).toEqual(viewport(fresh, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(host, 'normal'))
    } finally {
      client.dispose()
      host.dispose()
      fresh.dispose()
    }
  })
})
