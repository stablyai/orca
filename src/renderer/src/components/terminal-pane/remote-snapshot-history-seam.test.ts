import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'
import { writeHeadlessTerminal } from './pty-connection-test-async'
import { buildFoldedImageReplayWrites } from './terminal-snapshot-replay-paint'

// P2-5 / P2-7: a pushed snapshot is sent because the client's stream broke (dropped
// output, reconnect, restore), so the pane's own history ends somewhere before the
// image. Keeping that history under an image that carries none spliced the two with a
// silent gap. Real frames go through the real multiplexer and transport here; only the
// replay-drain's final paint is done by hand, with the same function it calls.

const COLS = 40
const ROWS = 5

function lines(term: Terminal): string[] {
  const buffer = term.buffer.normal
  return Array.from(
    { length: buffer.length },
    (_, row) => buffer.getLine(row)?.translateToString(true) ?? ''
  ).filter((line) => line.length > 0)
}

async function paneWithStaleHistory(): Promise<Terminal> {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
  await writeHeadlessTerminal(term, Array.from({ length: 40 }, (_, i) => `STALE-${i}`).join('\r\n'))
  return term
}

const SCREEN = 'LINE-1962\r\nLINE-1963'

describe('pushed remote snapshots never splice stale history above the image', () => {
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => void>()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.clearAllMocks()
    subscriptionCallbacks = null
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: vi.fn().mockResolvedValue({
            ok: true,
            result: {
              terminal: {
                handle: 'terminal-1',
                tabId: 'tab-1',
                leafId: 'pane:1',
                worktreeId: 'wt-1'
              }
            }
          }),
          subscribe: runtimeSubscribe
        }
      }
    })
  })

  async function attach() {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const onReplayData = vi.fn<(data: string, meta?: Record<string, unknown>) => void>()
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: COLS,
      rows: ROWS,
      callbacks: { onReplayData }
    })
    await expect.poll(() => subscriptionCallbacks !== null, { timeout: 5000 }).toBe(true)
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
    await expect
      .poll(() => subscriptionSendBinary.mock.calls.length, { timeout: 5000 })
      .toBeGreaterThan(0)
    const subscribe = subscriptionSendBinary.mock.calls
      .map(([bytes]) => decodeTerminalStreamFrame(bytes))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    const streamId = decodeTerminalStreamJson<{ streamId: number }>(subscribe!.payload)!.streamId
    const push = (start: Record<string, unknown>, body: string): void => {
      for (const [opcode, payload] of [
        [TerminalStreamOpcode.SnapshotStart, encodeTerminalStreamJson(start)],
        [TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(body)],
        [TerminalStreamOpcode.SnapshotEnd, new Uint8Array(0)]
      ] as const) {
        subscriptionCallbacks?.onBinary?.(
          encodeTerminalStreamFrame({ opcode, streamId, seq: 0, payload })
        )
      }
    }
    return { onReplayData, push }
  }

  async function paint(data: string, meta?: Record<string, unknown>): Promise<string[]> {
    const term = await paneWithStaleHistory()
    const writes = buildFoldedImageReplayWrites(data, false, meta?.carriesHistory === true)
    await writeHeadlessTerminal(term, writes.preamble)
    await writeHeadlessTerminal(term, writes.payload)
    const result = lines(term)
    term.dispose()
    return result
  }

  it('an older host’s screen-only first image replaces a restored history (P2-7)', async () => {
    const { onReplayData, push } = await attach()
    // Main-era hosts omit scrollbackRows.
    push({ cols: COLS, rows: ROWS, seq: 7, source: 'headless' }, SCREEN)
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
    const [data, meta] = onReplayData.mock.calls[0]!
    expect(meta).toEqual({ carriesNormalBuffer: true, snapshotCols: COLS, snapshotRows: ROWS })
    expect(await paint(data)).toEqual(['LINE-1962', 'LINE-1963'])
  })

  it.each([
    { host: 'an older host', fields: {} },
    { host: 'a host whose history did not fit', fields: { scrollbackRows: 0 } }
  ])(
    '$host: a screen-only recovery after dropped output drops the stale block (P2-5)',
    async ({ fields }) => {
      const { onReplayData, push } = await attach()
      push({ cols: COLS, rows: ROWS, seq: 7, source: 'headless', scrollbackRows: 1000 }, 'initial')
      await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
      push(
        {
          cols: COLS,
          rows: ROWS,
          seq: 9,
          source: 'headless',
          reason: 'ack-pending-overflow',
          ...fields
        },
        SCREEN
      )
      await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(2)
      const [data, meta] = onReplayData.mock.calls[1]!
      expect(meta).toEqual({ carriesNormalBuffer: true, snapshotCols: COLS, snapshotRows: ROWS })
      expect(data).toContain('\x1b[3J')
      expect(await paint(data)).toEqual(['LINE-1962', 'LINE-1963'])
    }
  )

  it('a recovery that carries host history replaces the stale block with it', async () => {
    const { onReplayData, push } = await attach()
    push({ cols: COLS, rows: ROWS, seq: 7, source: 'headless', scrollbackRows: 1000 }, 'initial')
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
    const hostHistory = Array.from({ length: 6 }, (_, i) => `LINE-${1956 + i}`).join('\r\n')
    push(
      { cols: COLS, rows: ROWS, seq: 9, source: 'headless', scrollbackRows: 6 },
      `${hostHistory}\r\n${SCREEN}`
    )
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(2)
    const [data, meta] = onReplayData.mock.calls[1]!
    expect(meta).toMatchObject({ carriesHistory: true })
    expect(await paint(data, meta)).toEqual(Array.from({ length: 8 }, (_, i) => `LINE-${1956 + i}`))
  })

  // A reconnect while a TUI runs: the pane's normal buffer froze when the TUI entered alt,
  // and an image without history has nothing to replace that pre-TUI scrollback with.
  async function paintOverLiveTui(data: string, meta?: Record<string, unknown>) {
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
    const history = Array.from({ length: 30 }, (_, i) => `HIST-${i}`).join('\r\n')
    await writeHeadlessTerminal(term, `${history}\r\n$ claude\x1b[?1049h\x1b[HAGENT-FRAME`)
    const writes = buildFoldedImageReplayWrites(data, true, meta?.carriesHistory === true)
    await writeHeadlessTerminal(term, writes.preamble)
    await writeHeadlessTerminal(term, writes.payload)
    const result = { normal: lines(term), active: term.buffer.active.type }
    term.dispose()
    return result
  }

  it('an older host’s screen-only image over a live TUI keeps the pre-TUI scrollback', async () => {
    const { onReplayData, push } = await attach()
    push(
      { cols: COLS, rows: ROWS, seq: 7, source: 'headless' },
      'HIST-28\r\nHIST-29\r\n$ claude\x1b[?1049h\x1b[HAGENT-FRAME-2'
    )
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
    const [data, meta] = onReplayData.mock.calls[0]!
    const painted = await paintOverLiveTui(data, meta)
    expect(painted.active).toBe('alternate')
    expect(painted.normal).toEqual([
      ...Array.from({ length: 30 }, (_, i) => `HIST-${i}`),
      '$ claude'
    ])
  })

  it('an image with history over a live TUI replaces the normal buffer with the host’s', async () => {
    const { onReplayData, push } = await attach()
    push(
      { cols: COLS, rows: ROWS, seq: 7, source: 'headless', scrollbackRows: 4 },
      'MISSED-0\r\nMISSED-1\r\nMISSED-2\r\nMISSED-3\r\n$ next\x1b[?1049h\x1b[HAGENT-FRAME-2'
    )
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
    const [data, meta] = onReplayData.mock.calls[0]!
    const painted = await paintOverLiveTui(data, meta)
    expect(painted.active).toBe('alternate')
    expect(painted.normal).toEqual(['MISSED-0', 'MISSED-1', 'MISSED-2', 'MISSED-3', '$ next'])
  })
})
