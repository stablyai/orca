import { describe, expect, it } from 'vitest'
import { WsInboundMessageQueue } from './ws-inbound-message-queue'

function gate() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function enqueuePayload(queue: WsInboundMessageQueue, value: number) {
  const payload = new Uint8Array(1024 * 1024)
  payload[0] = value
  return { ref: new WeakRef(payload), settled: queue.enqueue(payload) }
}

describe('WebSocket inbound message lifetime', () => {
  it.each([8])('preserves %i live frames and advances past a reported error', async (count) => {
    const wait = gate()
    const received: number[] = []
    const errors: unknown[] = []
    const queue = new WsInboundMessageQueue(
      async (raw) => {
        await wait.promise
        if (raw === 'error') {
          throw new Error('invalid frame')
        }
        if (!(raw instanceof Uint8Array)) {
          throw new Error('Expected binary frame')
        }
        received.push(raw[0]!)
      },
      (error) => errors.push(error)
    )
    const pending = Array.from({ length: count }, (_, index) => enqueuePayload(queue, index))
    const invalid = queue.enqueue('error')
    const successor = queue.enqueue(new Uint8Array([count]))
    await Promise.resolve()
    expect(received).toEqual([])
    wait.release()
    await Promise.all([...pending.map(({ settled }) => settled), invalid, successor])
    expect(received).toEqual(Array.from({ length: count + 1 }, (_, index) => index))
    expect(errors).toEqual([new Error('invalid frame')])
    queue.dispose()
  })
})
