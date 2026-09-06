import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'

// Client-side wire regression: the host dimensions every snapshot it publishes,
// but only the REQUESTED snapshot path ever read `cols`/`rows` back. Both PUSH
// paths (initial subscribe, server recovery) dropped them, so the pane parsed a
// host-grid image at its own grid and an idle TUI never repainted the damage.
// This drives REAL binary frames through the REAL multiplexer
// (decodeSnapshotInfo → onSnapshot meta) into the REAL transport
// (processData → onReplayData meta). One stream carries every case: the
// multiplexer is a module-level singleton, so separate cases would need
// separate module registries.

describe('remote transport snapshot source-grid threading', () => {
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  const subscriptionSendBinary = vi.fn()
  let subscriptionCallbacks: {
    onResponse: (response: unknown) => void
    onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
    onError?: (error: { code: string; message: string }) => void
    onClose?: () => void
  } | null = null

  beforeEach(() => {
    vi.resetModules()
    vi.doUnmock('../../runtime/remote-runtime-terminal-multiplexer')
    vi.clearAllMocks()
    subscriptionCallbacks = null
    subscriptionSendBinary.mockReset()
    runtimeCall.mockResolvedValue({
      ok: true,
      result: {
        terminal: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          leafId: 'pane:1',
          worktreeId: 'wt-1'
        }
      }
    })
    runtimeSubscribe.mockImplementation(
      async (_args: unknown, callbacks: typeof subscriptionCallbacks) => {
        subscriptionCallbacks = callbacks
        return { unsubscribe: vi.fn(), sendBinary: subscriptionSendBinary }
      }
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
      }
    })
  })

  it('carries the host grid on pushed snapshots and omits it when the host has none', async () => {
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('env-1', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    const onReplayData = vi.fn()
    transport.attach({
      existingPtyId: 'remote:env-1@@terminal-1',
      cols: 80,
      rows: 24,
      callbacks: { onReplayData }
    })

    await expect.poll(() => subscriptionCallbacks !== null, { timeout: 5000 }).toBe(true)
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })
    await expect
      .poll(() => subscriptionSendBinary.mock.calls.length, { timeout: 5000 })
      .toBeGreaterThan(0)
    const subscribeFrame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0] as Uint8Array))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    expect(subscribeFrame).toBeDefined()
    const streamId = decodeTerminalStreamJson<{ streamId: number }>(
      subscribeFrame!.payload
    )!.streamId

    const deliverSnapshot = (start: Record<string, unknown>, body: string): void => {
      for (const frame of [
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotStart,
          streamId,
          seq: 0,
          payload: encodeTerminalStreamJson(start)
        }),
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotChunk,
          streamId,
          seq: 0,
          payload: encodeTerminalStreamText(body)
        }),
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotEnd,
          streamId,
          seq: 0,
          payload: new Uint8Array(0)
        })
      ]) {
        subscriptionCallbacks?.onBinary?.(frame)
      }
    }

    // Initial subscribe push: the host's 143x43 grid must reach the restorer.
    deliverSnapshot({ cols: 143, rows: 43, seq: 7, source: 'headless' }, 'restored TUI frame')
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(1)
    expect(onReplayData).toHaveBeenLastCalledWith(
      'restored TUI frame',
      expect.objectContaining({ snapshotCols: 143, snapshotRows: 43 })
    )

    // Server-pushed recovery: untagged, after the initial snapshot landed.
    deliverSnapshot({ cols: 154, rows: 68, seq: 9, source: 'headless' }, 'recovered')
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(2)
    expect(onReplayData).toHaveBeenLastCalledWith(
      '\x1b[2J\x1b[3J\x1b[Hrecovered',
      expect.objectContaining({ snapshotCols: 154, snapshotRows: 68 })
    )

    // A host that publishes no dimensions must read as unknown, not as a grid.
    deliverSnapshot({ seq: 11, source: 'headless' }, 'undimensioned')
    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBe(3)
    const [, meta] = onReplayData.mock.calls[2] as [string, Record<string, unknown> | undefined]
    expect(meta?.snapshotCols).toBeUndefined()
    expect(meta?.snapshotRows).toBeUndefined()
  })
})
