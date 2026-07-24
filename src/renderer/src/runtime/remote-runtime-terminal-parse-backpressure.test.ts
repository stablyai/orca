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
  const unsubscribe = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  beforeEach(() => {
    vi.resetModules()
    sendBinary.mockReset()
    unsubscribe.mockReset()
    callbacks = null
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          subscribe: vi.fn(async (_args, nextCallbacks) => {
            callbacks = nextCallbacks
            queueMicrotask(() => {
              callbacks?.onResponse({ ok: true, result: { type: 'ready' } })
            })
            return { unsubscribe, sendBinary }
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
    await vi.waitFor(() => expect(sentAckBytes()).toEqual([output.byteLength]))
    stream.close()
  })

  it('batches parsed bulk output credit up to the byte threshold', async () => {
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
      terminal: 'term-bulk',
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
    sendBinary.mockClear()
    const output = encodeTerminalStreamText('x'.repeat(64 * 1024))

    for (let index = 0; index < 3; index += 1) {
      callbacks?.onBinary(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Output,
          streamId: stream.streamId,
          seq: index + 1,
          payload: output
        })
      )
    }

    expect(sentAckBytes()).toEqual([])
    for (const parsed of parsedCallbacks) {
      parsed()
    }
    expect(sentAckBytes()).toEqual([output.byteLength * 3])
    stream.close()
  })

  it('releases unknown streams and closes malformed connections instead of leaking credit', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const multiplexer = getRemoteRuntimeTerminalMultiplexer('windows-test')
    const stream = await multiplexer.subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn() }
    })
    sendBinary.mockClear()

    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId + 100,
        seq: 1,
        payload: encodeTerminalStreamText('x')
      })
    )
    expect(
      sendBinary.mock.calls.some(([bytes]) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return (
          frame?.opcode === TerminalStreamOpcode.Unsubscribe &&
          frame.streamId === stream.streamId + 100
        )
      })
    ).toBe(true)

    callbacks?.onBinary(new Uint8Array([1, 2, 3]))
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('credits malformed transformed output only after intentionally discarding it', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onData = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData, onSnapshot: vi.fn() }
    })
    sendBinary.mockClear()
    const malformed = encodeTerminalStreamJson({ data: 42, rawLength: 'wrong' })

    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.OutputSpan,
        streamId: stream.streamId,
        seq: 4,
        payload: malformed
      })
    )

    expect(onData).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sentAckBytes()).toEqual([malformed.byteLength]))
    expect(
      sendBinary.mock.calls.some(([bytes]) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return frame?.opcode === TerminalStreamOpcode.SnapshotRequest
      })
    ).toBe(true)
    stream.close()
  })

  it('passes transformed sequence metadata and cancels pending credit on disposal', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onData = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: { onData, onSnapshot: vi.fn() }
    })
    sendBinary.mockClear()
    const transformed = encodeTerminalStreamJson({
      data: 'visible',
      rawLength: 11,
      transformed: true
    })
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.OutputSpan,
        streamId: stream.streamId,
        seq: 21,
        payload: transformed
      })
    )

    expect(onData).toHaveBeenCalledWith('visible', {
      seq: 21,
      rawLength: 11,
      transformed: true
    })
    stream.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sentAckBytes()).toEqual([])
  })

  it('settles a late parser callback locally after the server ends the stream', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../lib/pane-manager/terminal-delivery-credit')
    const parsedCredits: (() => void)[] = []
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          const credit = takeCurrentTerminalDeliveryCredit()
          if (credit) {
            parsedCredits.push(credit)
          }
        },
        onSnapshot: vi.fn()
      }
    })
    sendBinary.mockClear()
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('x')
      })
    )
    callbacks?.onResponse({ ok: true, result: { type: 'end', streamId: stream.streamId } })

    parsedCredits[0]?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sentAckBytes()).toEqual([])
  })

  it('closes without ACKing when the renderer delivery callback throws', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          throw new Error('renderer delivery failed')
        },
        onSnapshot: vi.fn()
      }
    })
    sendBinary.mockClear()

    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('x')
      })
    )

    expect(unsubscribe).toHaveBeenCalledOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(sentAckBytes()).toEqual([])
  })

  it('closes and releases server debt when an ACK transport write throws', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../lib/pane-manager/terminal-delivery-credit')
    const parseCredits: (() => void)[] = []
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-codex',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          const credit = takeCurrentTerminalDeliveryCredit()
          if (credit) {
            parseCredits.push(credit)
          }
        },
        onSnapshot: vi.fn()
      }
    })
    sendBinary.mockClear()
    sendBinary.mockImplementation((bytes) => {
      const frame = decodeTerminalStreamFrame(bytes)
      if (frame?.opcode === TerminalStreamOpcode.Ack) {
        throw new Error('socket closed')
      }
    })
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId: stream.streamId,
        seq: 1,
        payload: encodeTerminalStreamText('x')
      })
    )

    expect(parseCredits).toHaveLength(1)
    parseCredits[0]?.()

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    expect(sentAckBytes()).toEqual([1])
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
