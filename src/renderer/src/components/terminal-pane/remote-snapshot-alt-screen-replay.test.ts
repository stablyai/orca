import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { flushAsyncTicks, writeHeadlessTerminal } from './pty-connection-test-async'
import { buildMainModelSnapshotReplayWrites } from './terminal-snapshot-replay-paint'
import { createMockTransport, createPane, createManager } from './pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from './pty-connection-test-pane-fixtures'
import type { PtyReplayDataMeta } from './pty-transport-types'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/store', () => ({
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
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

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

const COLS = 40
const ROWS = 6
// A setup script's output, then an agent TUI that entered the alt screen over it. Under a
// live TUI the normal buffer is frozen, so host and pane hold the same one.
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
  return `\x1b[?2026l\x1b[2J\x1b[H${pushedImage(hostRows)}`
}
const REQUESTED_IMAGE = `${NORMAL_LINES.join('\r\n')}${ENTER_AGENT_FRAME}`

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
    meta: PtyReplayDataMeta
  ): Promise<PaneEvent[]> {
    const { connectPanePty } = await import('./pty-connection')
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
    pane.terminal.write.mockImplementation((chunk: string, callback?: () => void) => {
      if (chunk.length > 0) {
        events.push(chunk)
      }
      if (callback) {
        parseCallbacks.push(callback)
      }
    })
    pane.terminal.resize.mockImplementation((cols: number, rows: number) => {
      pane.terminal.cols = cols
      pane.terminal.rows = rows
      events.push({ cols, rows })
    })
    const deps = buildPaneConnectionDeps(() => mockStoreState)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const binding = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    pane.terminal.cols = COLS
    pane.terminal.rows = ROWS
    pane.terminal.buffer.active.type = 'alternate'
    replay.current?.(data, meta)
    for (let index = 0; index < 12; index += 1) {
      await flushAsyncTicks(4)
      parseCallbacks.shift()?.()
    }
    await flushAsyncTicks(8)
    binding.dispose()
    expect(events).toContain(data)
    return [...events, { cols: COLS, rows: ROWS }]
  }

  // Why: a revisited remote tab running an agent TUI gets a pushed snapshot while xterm
  // is on the agent's alt screen. Cleared in place, the image's normal screen (old setup
  // output) painted into the agent's screen, under its next paints.
  it('repaints a pushed image exactly and keeps the history the TUI covers', async () => {
    const payload = recoveryPayload(ROWS)
    const client = await render([
      LIVE_PANE,
      ...(await drainOntoLiveAltScreen(payload, {
        carriesNormalBuffer: true,
        snapshotCols: COLS,
        snapshotRows: ROWS
      }))
    ])
    const host = await render([LIVE_PANE])
    const fresh = await render([pushedImage(ROWS)])
    try {
      expect(client.buffer.active.type).toBe('alternate')
      expect(viewport(client, 'alternate')).toEqual(viewport(fresh, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(host, 'normal'))
    } finally {
      client.dispose()
      host.dispose()
      fresh.dispose()
    }
  })

  // Why: the pane's history continues the host's screen only on the same grid; on
  // another grid, keeping it duplicates or drops lines, so the image replaces it.
  it('replaces history exactly when the host screen has another grid', async () => {
    const hostRows = 10
    const client = await render([
      LIVE_PANE,
      ...(await drainOntoLiveAltScreen(recoveryPayload(hostRows), {
        carriesNormalBuffer: true,
        snapshotCols: COLS,
        snapshotRows: hostRows
      }))
    ])
    const fresh = await render([pushedImage(hostRows), { cols: COLS, rows: ROWS }], hostRows)
    try {
      expect(viewport(client, 'alternate')).toEqual(viewport(fresh, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(fresh, 'normal'))
    } finally {
      client.dispose()
      fresh.dispose()
    }
  })

  // Why: once the host's TUI exits, the shell writes past the pane's history, so the
  // image replaces it instead of leaving a gap above the host's screen.
  it('replaces history once the host proves the TUI exited', async () => {
    const hostScreen = [...NORMAL_LINES, 'Resume with claude --resume', '$ ']
      .slice(-ROWS)
      .join('\r\n')
    const client = await render([
      LIVE_PANE,
      ...(await drainOntoLiveAltScreen(`\x1b[?2026l\x1b[2J\x1b[H${hostScreen}`, {
        carriesNormalBuffer: true,
        terminalOwner: 'shell',
        alternateScreen: false,
        snapshotCols: COLS,
        snapshotRows: ROWS
      }))
    ])
    const fresh = await render([hostScreen])
    try {
      expect(client.buffer.active.type).toBe('normal')
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(fresh, 'normal'))
    } finally {
      client.dispose()
      fresh.dispose()
    }
  })

  // Why: an SSH relay replays a raw byte window, not an image; it continues the TUI on
  // the alt screen and must leave the normal buffer alone.
  it('clears a raw byte replay in place on the alt screen', async () => {
    const client = await render([LIVE_PANE, ...(await drainOntoLiveAltScreen(AGENT_FRAME, {}))])
    const expected = await render([LIVE_PANE, `\x1b[2J${AGENT_FRAME}`])
    try {
      expect(client.buffer.active.type).toBe('alternate')
      expect(viewport(client, 'alternate')).toEqual(viewport(expected, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(expected, 'normal'))
    } finally {
      client.dispose()
      expected.dispose()
    }
  })

  // Why: hidden-output restore paints requested snapshots, which fold history in too.
  it('paints a requested image exactly over a live alt screen', async () => {
    const client = await render([
      LIVE_PANE,
      ...buildMainModelSnapshotReplayWrites(
        { data: REQUESTED_IMAGE, alternateScreen: true, carriesNormalBuffer: true },
        { paneOnAlternateScreen: true }
      )
    ])
    const fresh = await render([REQUESTED_IMAGE])
    try {
      expect(viewport(client, 'alternate')).toEqual(viewport(fresh, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(fresh, 'normal'))
    } finally {
      client.dispose()
      fresh.dispose()
    }
  })
})
