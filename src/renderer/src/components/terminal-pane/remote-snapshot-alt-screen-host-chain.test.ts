import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import { flushAsyncTicks, writeHeadlessTerminal } from './pty-connection-test-async'
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

// Why this suite: remote-snapshot-alt-screen-replay.test.ts hand-writes the replay meta, and
// once fed a shape the host never sends. Here every input is produced by the real code:
// the host runtime's headless model and shell-ownership proof, its ack-recovery publisher,
// the wire codec, the client multiplexer, and the remote transport. Only the hand-off from
// the transport's onReplayData into the pane's callback is wired by the test.

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

vi.mock('./pty-transport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

// Host-only surfaces, typed here so the renderer typecheck never walks the main graph.
type HostSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  source?: string
  alternateScreen?: boolean
  terminalOwner?: 'shell'
}
type HostRuntime = {
  setPtyController(controller: {
    write: () => boolean
    kill: () => boolean
    getForegroundProcess: () => Promise<null>
    getSize: () => { cols: number; rows: number }
    confirmShellForeground: () => Promise<boolean>
  }): void
  registerPty(ptyId: string, worktreeId: string): void
  onPtyData(ptyId: string, data: string, at: number): number
}
type HostSendFrame = (opcode: number, payload?: Uint8Array<ArrayBufferLike>) => boolean
type HostStream = {
  streamId: number
  ptyId: string
  outputPaused: boolean
  ackRecoverySnapshotInFlight: boolean
  ackOutputSourceRanges: boolean
  ackPendingOutput: unknown[]
  ackPendingOutputBytes: number
  ackPendingOutputOverflowed: boolean
}
type HostConnection = {
  runtime: HostRuntime
  streams: Map<number, HostStream>
  closed: boolean
  sendFrame: (streamId: number, opcode: number, payload?: Uint8Array<ArrayBufferLike>) => boolean
  sendStreamError: (streamId: number, message: string) => void
  sendAckRecoverySnapshot?: (stream: HostStream) => Promise<void>
}

const COLS = 40
const ROWS = 6
const PTY_ID = 'host-pty'
const COMMAND_START = '\x1b]133;C\x07'
// A setup script's output, then an agent TUI entering the alt screen over it.
const LIVE_PANE = `${Array.from({ length: 10 }, (_, i) => `SETUP-OUTPUT-${i}`).join('\r\n')}\r\n$ claude${COMMAND_START}\x1b[?1049h\x1b[2J\x1b[HOLD-AGENT-FRAME`
// Output the client missed before the host's recovery push.
const AGENT_FRAME = '\x1b[H\x1b[2;1HNo\x1b[1Cnotice\x1b[1Ctoday'
const AGENT_EXIT = `${AGENT_FRAME}\x1b[?1049lResume with claude --resume\r\n\x1b]133;D;0\x07\x1b]133;A\x07$ `

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

async function render(events: PaneEvent[]): Promise<Terminal> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
  for (const event of events) {
    if (typeof event === 'string') {
      await writeHeadlessTerminal(term, event)
    } else {
      term.resize(event.cols, event.rows)
    }
  }
  return term
}

/** Real host + client chain: returns what the remote transport hands the pane for the push. */
async function publishHostRecovery(
  missed: string
): Promise<{ data: string; meta: PtyReplayDataMeta; published: HostSnapshot }> {
  const { OrcaRuntimeService } = await vi.importActual<{
    OrcaRuntimeService: new (store: null) => HostRuntime
  }>('../../../../main/runtime/orca-runtime')
  const { sendSnapshotFrames, serializeBudgetedRequestedSnapshot } = await vi.importActual<{
    sendSnapshotFrames: (send: HostSendFrame, options: Record<string, unknown>) => unknown
    serializeBudgetedRequestedSnapshot: (
      runtime: HostRuntime,
      ptyId: string,
      scrollbackRows: number
    ) => Promise<HostSnapshot | null>
  }>('../../../../main/runtime/rpc/methods/terminal/terminal-snapshot-publication')
  const { installMultiplexFlowControl } = await vi.importActual<{
    installMultiplexFlowControl: (build: HostConnection) => void
  }>('../../../../main/runtime/rpc/methods/terminal/terminal-multiplex-flow-control')

  const host = new OrcaRuntimeService(null)
  host.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: COLS, rows: ROWS }),
    // The host has verified the shell is back in the foreground at the exit marker.
    confirmShellForeground: async () => true
  })
  host.registerPty(PTY_ID, 'wt-1')
  host.onPtyData(PTY_ID, LIVE_PANE, Date.now())

  const runtimeSubscribe = vi.fn()
  const sendBinary = vi.fn()
  let toClient: ((bytes: Uint8Array<ArrayBufferLike>) => void) | undefined
  runtimeSubscribe.mockImplementation(
    async (
      _args: unknown,
      callbacks: {
        onResponse: (response: unknown) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
      }
    ) => {
      toClient = callbacks.onBinary
      queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
      return { unsubscribe: vi.fn(), sendBinary }
    }
  )
  const runtimeCall = vi.fn().mockResolvedValue({
    ok: true,
    result: {
      terminal: { handle: 'terminal-1', tabId: 'tab-1', leafId: 'pane:1', worktreeId: 'wt-1' }
    }
  })
  Object.assign(window.api, {
    runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
  })

  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  const onReplayData = vi.fn<(data: string, meta?: PtyReplayDataMeta) => void>()
  transport.attach({
    existingPtyId: 'remote:env-1@@terminal-1',
    cols: COLS,
    rows: ROWS,
    callbacks: { onReplayData }
  })
  await expect
    .poll(() =>
      sendBinary.mock.calls.some(
        ([bytes]) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Subscribe
      )
    )
    .toBe(true)
  const subscribe = sendBinary.mock.calls
    .map(([bytes]) => decodeTerminalStreamFrame(bytes))
    .find((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
  const streamId = decodeTerminalStreamJson<{ streamId: number }>(subscribe!.payload)!.streamId
  const sendFrame = (
    id: number,
    opcode: number,
    payload?: Uint8Array<ArrayBufferLike>
  ): boolean => {
    toClient?.(
      encodeTerminalStreamFrame({
        opcode,
        streamId: id,
        seq: 0,
        payload: payload ?? new Uint8Array()
      })
    )
    return true
  }

  // The initial push only opens the stream; the pane below already parsed these bytes live.
  const initial = await serializeBudgetedRequestedSnapshot(host, PTY_ID, 0)
  sendSnapshotFrames((opcode, payload) => sendFrame(streamId, opcode, payload), {
    kind: 'scrollback',
    cols: initial!.cols,
    rows: initial!.rows,
    seq: initial!.seq,
    source: initial!.source,
    data: initial!.data
  })
  await expect.poll(() => onReplayData.mock.calls.length).toBe(1)

  host.onPtyData(PTY_ID, missed, Date.now())
  const stream: HostStream = {
    streamId,
    ptyId: PTY_ID,
    outputPaused: false,
    ackRecoverySnapshotInFlight: false,
    ackOutputSourceRanges: false,
    ackPendingOutput: [],
    ackPendingOutputBytes: 0,
    ackPendingOutputOverflowed: false
  }
  const connection: HostConnection = {
    runtime: host,
    streams: new Map([[streamId, stream]]),
    closed: false,
    sendFrame,
    sendStreamError: (_id, message) => {
      throw new Error(message)
    }
  }
  const published = await serializeBudgetedRequestedSnapshot(host, PTY_ID, 0)
  installMultiplexFlowControl(connection)
  await connection.sendAckRecoverySnapshot?.(stream)
  await expect.poll(() => onReplayData.mock.calls.length).toBe(2)
  transport.destroy?.()
  const [data, meta] = onReplayData.mock.calls[1]!
  return { data, meta: meta ?? {}, published: published! }
}

describe('host-published recovery snapshot onto a live alt screen', () => {
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
    expect(
      events.some((event) => typeof event === 'string' && event.length > 0 && data.endsWith(event))
    ).toBe(true)
    return [...events, { cols: COLS, rows: ROWS }]
  }

  // Why: while the TUI lives, the host publishes no owner, so the alt flag never reaches
  // the client; the pane must keep the setup history the TUI's alt screen covers.
  it('keeps the covered history for a live TUI exactly as the host holds it', async () => {
    const { data, meta, published } = await publishHostRecovery(AGENT_FRAME)
    expect(published.alternateScreen).toBe(true)
    expect(meta.terminalOwner).toBeUndefined()
    expect(meta.alternateScreen).toBeUndefined()
    const client = await render([LIVE_PANE, ...(await drainOntoLiveAltScreen(data, meta))])
    const host = await render([LIVE_PANE, AGENT_FRAME])
    try {
      expect(client.buffer.active.type).toBe('alternate')
      expect(viewport(client, 'alternate')).toEqual(viewport(host, 'alternate'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(host, 'normal'))
    } finally {
      client.dispose()
      host.dispose()
    }
  })

  // Why: once the host's TUI exits, its image no longer enters alt; the pane must leave
  // alt and show the host's normal screen.
  it('repaints from the normal buffer once the host TUI has exited', async () => {
    const { data, meta } = await publishHostRecovery(AGENT_EXIT)
    expect(meta.terminalOwner).toBe('shell')
    expect(meta.alternateScreen).toBe(false)
    const client = await render([LIVE_PANE, ...(await drainOntoLiveAltScreen(data, meta))])
    const host = await render([LIVE_PANE, AGENT_EXIT])
    const fresh = await render([data])
    try {
      expect(client.buffer.active.type).toBe('normal')
      expect(viewport(client, 'normal')).toEqual(viewport(host, 'normal'))
      expect(bufferLines(client, 'normal')).toEqual(bufferLines(fresh, 'normal'))
    } finally {
      client.dispose()
      host.dispose()
      fresh.dispose()
    }
  })
})
