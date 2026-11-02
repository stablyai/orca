import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeFrame, MessageType } from './protocol'

// Why both id shapes: parseJsonRpcMessage only checks the version, so a request id may arrive as a
// string, while rpc.cancel coerces its id through Number(...). The abort index must file both
// under one key or the cancel for a string-id request is silently dropped.
describe('rpc.cancel request-id coercion', () => {
  let dispatcher: RelayDispatcher

  beforeEach(() => {
    vi.useFakeTimers()
    dispatcher = new RelayDispatcher(() => {})
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it.each([
    { label: 'numeric', requestId: 7, cancelId: 7 },
    { label: 'string', requestId: '7', cancelId: '7' },
    { label: 'string request, numeric cancel', requestId: '7', cancelId: 7 }
  ])('aborts an in-flight request with a $label id', async ({ requestId, cancelId }) => {
    let signal: AbortSignal | undefined
    dispatcher.onRequest('test.slow', (_params, ctx) => {
      signal = ctx.signal
      return new Promise(() => {})
    })
    // Raw frames: the typed encoder would not admit a string id, and that is the point.
    const rawFrame = (msg: Record<string, unknown>, seq: number): Buffer =>
      encodeFrame(MessageType.Regular, seq, 0, Buffer.from(JSON.stringify(msg), 'utf-8'))

    dispatcher.feed(rawFrame({ jsonrpc: '2.0', id: requestId, method: 'test.slow' }, 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(signal?.aborted).toBe(false)

    dispatcher.feed(rawFrame({ jsonrpc: '2.0', method: 'rpc.cancel', params: { id: cancelId } }, 2))

    expect(signal?.aborted).toBe(true)
  })
})
