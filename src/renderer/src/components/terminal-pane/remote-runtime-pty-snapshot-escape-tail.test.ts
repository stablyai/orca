import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'

// Client-side wire regression for #7329: the daemon's pendingEscapeTailAnsi
// rides the SnapshotStart JSON frame. This drives REAL binary frames through
// the REAL multiplexer (decodeSnapshotInfo → onSnapshot meta) into the REAL
// transport (processData → onReplayData meta). The server-side counterpart is
// terminal-multiplex-escape-tail.test.ts; without this test the client half of
// the chain could silently drop the field and every suite stayed green.

describe('remote transport snapshot escape-tail threading (#7329)', () => {
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

  it('delivers the SnapshotStart pendingEscapeTailAnsi to onReplayData meta', async () => {
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

    // Complete the multiplexer handshake so the terminal stream subscribes.
    await expect.poll(() => subscriptionCallbacks !== null, { timeout: 5000 }).toBe(true)
    subscriptionCallbacks?.onResponse({ ok: true, result: { type: 'ready' } })

    // The client allocates the terminal's stream id in its Subscribe payload.
    await expect
      .poll(() => subscriptionSendBinary.mock.calls.length, { timeout: 5000 })
      .toBeGreaterThan(0)
    const subscribeFrame = subscriptionSendBinary.mock.calls
      .map((call) => decodeTerminalStreamFrame(call[0] as Uint8Array))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Subscribe)
    expect(subscribeFrame).toBeDefined()
    const subscribePayload = decodeTerminalStreamJson<{ streamId: number }>(subscribeFrame!.payload)
    const streamId = subscribePayload!.streamId

    // Server → client: initial snapshot whose emulator sat mid-escape.
    const frames = [
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId,
        seq: 0,
        payload: encodeTerminalStreamJson({
          cols: 80,
          rows: 24,
          seq: 7,
          source: 'headless',
          pendingEscapeTailAnsi: '\x1b[3'
        })
      }),
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotChunk,
        streamId,
        seq: 0,
        payload: encodeTerminalStreamText('user@host:~$ ')
      }),
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId,
        seq: 0,
        payload: new Uint8Array(0)
      })
    ]
    for (const frame of frames) {
      subscriptionCallbacks?.onBinary?.(frame)
    }

    await expect.poll(() => onReplayData.mock.calls.length, { timeout: 5000 }).toBeGreaterThan(0)
    expect(onReplayData).toHaveBeenCalledWith(
      'user@host:~$ ',
      expect.objectContaining({ pendingEscapeTailAnsi: '\x1b[3' })
    )
  })
})
