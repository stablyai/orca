import { describe, expect, it } from 'vitest'
import { WsInboundMessageBudget, WsInboundMessageQueue } from './ws-inbound-message-queue'

function gate() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function enqueuePayload(queue: WsInboundMessageQueue, value: number) {
  const payload = new Uint8Array(64 * 1024)
  payload[0] = value
  return { ref: new WeakRef(payload), settled: queue.enqueue(payload) }
}

describe('WebSocket inbound message lifetime', () => {
  it('admits a replacement after disposing pending frames behind a blocked conversion', async () => {
    const budget = new WsInboundMessageBudget()
    const wait = gate()
    const errors: unknown[] = []
    const retired = new WsInboundMessageQueue(
      () => wait.promise,
      (error) => errors.push(error),
      budget
    )
    const active = retired.enqueue('active')
    await Promise.resolve()
    const pending = Array.from({ length: 255 }, () => retired.enqueue('pending'))
    retired.dispose()
    const received: unknown[] = []
    const replacement = new WsInboundMessageQueue(
      (raw) => {
        received.push(raw)
      },
      (error) => errors.push(error),
      budget
    )
    try {
      await replacement.enqueue('ready')
      expect(received).toEqual(['ready'])
      expect(errors).toEqual([])
    } finally {
      replacement.dispose()
      wait.release()
      await Promise.all([active, ...pending])
    }
  })

  it.each([1, 10])('bounds admission at %ix load while conversion is blocked', async (load) => {
    const wait = gate()
    const received: unknown[] = []
    const errors: unknown[] = []
    const queue = new WsInboundMessageQueue(
      async (raw) => {
        received.push(raw)
        await wait.promise
      },
      (error) => errors.push(error)
    )
    const active = queue.enqueue(new Uint8Array(8 * 1024 * 1024))
    await Promise.resolve()
    const pending = Array.from({ length: 8 * load }, () =>
      queue.enqueue(new Uint8Array(8 * 1024 * 1024))
    )
    expect(errors).toHaveLength(1)
    wait.release()
    await Promise.all([active, ...pending])
    expect(received).toHaveLength(1)
  })

  it.each([8, 80])(
    'releases %i queued payloads while the active conversion is blocked',
    async (count) => {
      const wait = gate()
      const received: unknown[] = []
      const errors: unknown[] = []
      const queue = new WsInboundMessageQueue(
        async (raw) => {
          await wait.promise
          received.push(raw)
        },
        (error) => errors.push(error)
      )
      const active = queue.enqueue('active')
      await Promise.resolve()
      const pending = Array.from({ length: count }, (_, index) => enqueuePayload(queue, index))
      try {
        await collect()
        expect(pending.filter(({ ref }) => ref.deref() !== undefined)).toHaveLength(count)
        queue.dispose()
        await collect()
        expect(pending.filter(({ ref }) => ref.deref() !== undefined)).toHaveLength(0)
        await queue.enqueue('closed')
      } finally {
        queue.dispose()
        wait.release()
        await Promise.all([active, ...pending.map(({ settled }) => settled)])
      }
      expect(received).toEqual(['active'])
      expect(errors).toEqual([])
    }
  )

  it.each([8, 80])('preserves %i live frames and advances past a reported error', async (count) => {
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

  it.each([8, 80])(
    'releases %i completed payloads while a later conversion is blocked',
    async (count) => {
      const wait = gate()
      const received: number[] = []
      const errors: unknown[] = []
      const queue = new WsInboundMessageQueue(
        async (raw) => {
          if (raw === 'blocked') {
            await wait.promise
          } else if (raw instanceof Uint8Array) {
            received.push(raw[0]!)
          }
        },
        (error) => errors.push(error)
      )
      const completed = Array.from({ length: count }, (_, index) => enqueuePayload(queue, index))
      await Promise.all(completed.map(({ settled }) => settled))
      const active = queue.enqueue('blocked')
      await Promise.resolve()
      try {
        await collect()
        expect(completed.filter(({ ref }) => ref.deref() !== undefined)).toHaveLength(0)
        expect(received).toEqual(Array.from({ length: count }, (_, index) => index))
        expect(errors).toEqual([])
      } finally {
        wait.release()
        await active
        queue.dispose()
      }
    }
  )

  it('suppresses errors from an active conversion that finishes after disposal', async () => {
    const wait = gate()
    const errors: unknown[] = []
    const queue = new WsInboundMessageQueue(
      async () => {
        await wait.promise
        throw new Error('retired conversion')
      },
      (error) => errors.push(error)
    )
    const active = queue.enqueue('active')
    await Promise.resolve()
    queue.dispose()
    wait.release()
    await active
    expect(errors).toEqual([])
  })
})
