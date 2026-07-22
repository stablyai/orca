import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

describe('remote terminal renderer backpressure', () => {
  const sendBinary = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  beforeEach(() => {
    vi.resetModules()
    sendBinary.mockReset()
    callbacks = null
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args, nextCallbacks) => {
            callbacks = nextCallbacks
            queueMicrotask(() => {
              callbacks?.onResponse({ ok: true, result: { type: 'ready' } })
            })
            return { unsubscribe: vi.fn(), sendBinary }
          })
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('withholds server credit until xterm consumes the output frame', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../lib/pane-manager/terminal-delivery-credit')
    const { writeTerminalOutput } =
      await import('../lib/pane-manager/pane-terminal-output-scheduler')
    const parsedCallbacks: (() => void)[] = []
    const terminal = {
      write: vi.fn((_data: string, parsed?: () => void) => {
        if (parsed) {
          parsedCallbacks.push(parsed)
        }
      })
    }
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: (data) => {
          writeTerminalOutput(terminal, data, {
            foreground: true,
            ackCredit: takeCurrentTerminalDeliveryCredit() ?? undefined
          })
        },
        onSnapshot: vi.fn()
      }
    })

    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotStart,
        streamId: stream.streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({ kind: 'scrollback', seq: 0 })
      })
    )
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotEnd,
        streamId: stream.streamId,
        seq: 2,
        payload: new Uint8Array()
      })
    )
    sendBinary.mockClear()

    const text = '\x1b[?1049h\x1b[?2026h\x1b[2J\x1b[H\x1b[31m-red 🙂 界\x1b[0m\x1b[?2026l'
    const output = encodeTerminalStreamText(text)
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId,
        seq: text.length,
        payload: output
      })
    )

    expect(terminal.write).toHaveBeenCalledWith(text, expect.any(Function))
    expect(parsedCallbacks).toHaveLength(1)
    expect(sentAckBytes()).toEqual([])

    parsedCallbacks.shift()?.()
    expect(sentAckBytes()).toEqual([output.byteLength])
    stream.close()
  })

  function sentAckBytes(): number[] {
    return sendBinary.mock.calls.flatMap(([bytes]) => {
      const frame = decodeTerminalStreamFrame(bytes)
      if (frame?.opcode !== TerminalStreamOpcode.Ack) {
        return []
      }
      const payload = decodeTerminalStreamJson<{ bytes?: number }>(frame.payload)
      return typeof payload?.bytes === 'number' ? [payload.bytes] : []
    })
  }
})
