import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import { REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS } from './recovery/remote-terminal-stream-watchdog'
import { TERMINAL_MULTIPLEX_ACK_FLUSH_MS } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'

describe('remote terminal stalled stream recovery', () => {
  const sendBinary = vi.fn()
  const unsubscribe = vi.fn()
  const recordBreadcrumb = vi.fn()
  let callbacks: {
    onResponse: (response: unknown) => void
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  } | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    sendBinary.mockReset()
    unsubscribe.mockReset()
    recordBreadcrumb.mockReset()
    callbacks = null
    vi.stubGlobal('window', {
      api: {
        crashReports: {
          recordBreadcrumb
        },
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
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the delivery deadline anchored while sibling frames keep settling', async () => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./registry/remote-runtime-terminal-multiplexer-registry')
    const { takeCurrentTerminalDeliveryCredit } =
      await import('../../../lib/pane-manager/terminal-delivery-credit')
    const credits: (() => void)[] = []
    const onTransportClose = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('windows-test').subscribeTerminal({
      terminal: 'term-anchored',
      client: { id: 'mac-viewer', type: 'desktop' },
      callbacks: {
        onData: () => {
          const credit = takeCurrentTerminalDeliveryCredit()
          if (credit) {
            credits.push(credit)
          }
        },
        onSnapshot: vi.fn(),
        onTransportClose
      }
    })
    sendBinary.mockClear()

    emitOutput(stream.streamId, 'frame the renderer never parses')
    await vi.advanceTimersByTimeAsync(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS - 5_000)
    emitOutput(stream.streamId, 'sibling frame that settles')
    credits[1]?.()
    await vi.advanceTimersByTimeAsync(TERMINAL_MULTIPLEX_ACK_FLUSH_MS)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(onTransportClose).toHaveBeenCalledWith({ recoverable: true, stalled: true })
    expect(sentUnsubscribeStreamIds()).toEqual([stream.streamId])
  })

  function emitOutput(streamId: number, text: string): void {
    callbacks?.onBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        streamId,
        seq: text.length,
        payload: encodeTerminalStreamText(text)
      })
    )
  }

  function sentFrames(opcode: TerminalStreamOpcode) {
    return sendBinary.mock.calls.flatMap(([bytes]) => {
      const frame = decodeTerminalStreamFrame(bytes)
      return frame?.opcode === opcode ? [frame] : []
    })
  }

  function sentUnsubscribeStreamIds(): number[] {
    return sentFrames(TerminalStreamOpcode.Unsubscribe).map((frame) => frame.streamId)
  }
})
