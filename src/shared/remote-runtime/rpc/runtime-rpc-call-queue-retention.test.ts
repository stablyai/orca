import { describe, expect, it } from 'vitest'
import { RuntimeRpcCallQueuePool } from './runtime-rpc-call-queue'

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function enqueuePayload(
  queue: RuntimeRpcCallQueuePool,
  method: string,
  wait: Promise<void>,
  signal?: AbortSignal
): { ref: WeakRef<Uint8Array>; settled: Promise<number> } {
  const payload = new Uint8Array(1024 * 1024)
  payload[0] = 19
  return {
    ref: new WeakRef(payload),
    settled: queue.enqueue(
      'runtime-a',
      method,
      async () => {
        await wait
        return payload[0]!
      },
      payload.byteLength,
      signal
    )
  }
}

async function completePayload(
  queue: RuntimeRpcCallQueuePool,
  method: string
): Promise<WeakRef<Uint8Array>> {
  const { ref, settled } = enqueuePayload(queue, method, Promise.resolve())
  expect(await settled).toBe(19)
  return ref
}

describe('runtime RPC completed-call retention', () => {
  it.each(['terminal.send', 'git.status'])(
    'releases completed %s inputs while another call keeps the selector active',
    async (method) => {
      const queue = new RuntimeRpcCallQueuePool(3, 2)
      const blocker = gate()
      const active = queue.enqueue('runtime-a', 'terminal.send', () => blocker.promise)
      try {
        const refs: WeakRef<Uint8Array>[] = []
        for (let index = 0; index < 8; index += 1) {
          refs.push(await completePayload(queue, method))
        }
        await collect()
        expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0)
      } finally {
        blocker.release()
        await active
      }
    }
  )

  it.each(['terminal.send', 'git.status'])(
    'keeps an active %s input and releases a cancelled queued input',
    async (method) => {
      const queue = new RuntimeRpcCallQueuePool(1, 1)
      const blocker = gate()
      const active = enqueuePayload(queue, method, blocker.promise)
      const controller = new AbortController()
      const queued = enqueuePayload(queue, method, Promise.resolve(), controller.signal)
      const rejected = expect(queued.settled).rejects.toMatchObject({ name: 'AbortError' })
      try {
        await collect()
        expect(active.ref.deref()?.[0]).toBe(19)
        expect(queued.ref.deref()?.[0]).toBe(19)
        controller.abort()
        await rejected
        await collect()
        expect(active.ref.deref()?.[0]).toBe(19)
        expect(queued.ref.deref() === undefined).toBe(true)
      } finally {
        controller.abort()
        blocker.release()
        await Promise.allSettled([active.settled, queued.settled])
      }
      expect(await active.settled).toBe(19)
      await collect()
      expect(active.ref.deref() === undefined).toBe(true)
    }
  )

  it('releases old foreground inputs during continuous finite background calls', async () => {
    const queue = new RuntimeRpcCallQueuePool(3, 2)
    const startBackground = (): { release: () => void; settled: Promise<void> } => {
      const wait = gate()
      return {
        release: wait.release,
        settled: queue.enqueue('runtime-a', 'git.status', () => wait.promise)
      }
    }
    let active = startBackground()
    try {
      const ref = await completePayload(queue, 'terminal.send')
      for (let index = 0; index < 70; index += 1) {
        const next = startBackground()
        active.release()
        await active.settled
        active = next
      }
      await collect()
      expect(ref.deref() === undefined).toBe(true)
    } finally {
      active.release()
      await active.settled
    }
  })

  it('preserves lane order and queued cancellation across compaction', async () => {
    const queue = new RuntimeRpcCallQueuePool(1, 1)
    const blocker = gate()
    const active = queue.enqueue('runtime-a', 'terminal.send', () => blocker.promise)
    const started: string[] = []
    const pending: Promise<string>[] = []
    const cancelled = new Set([
      'foreground:0',
      'foreground:35',
      'foreground:69',
      'background:0',
      'background:35',
      'background:69'
    ])
    for (const lane of ['background', 'foreground']) {
      for (let index = 0; index < 70; index += 1) {
        const id = `${lane}:${index}`
        const controller = new AbortController()
        const settled = queue.enqueue(
          'runtime-a',
          lane === 'background' ? 'git.status' : 'terminal.send',
          async () => {
            started.push(id)
            return id
          },
          0,
          controller.signal
        )
        if (cancelled.has(id)) {
          pending.push(
            settled.catch((error: unknown) => {
              expect(error).toMatchObject({ name: 'AbortError' })
              return 'cancelled'
            })
          )
          controller.abort()
        } else {
          pending.push(settled)
        }
      }
    }
    blocker.release()
    await active
    const results = await Promise.all(pending)
    const expected = ['foreground', 'background']
      .flatMap((lane) => Array.from({ length: 70 }, (_, index) => `${lane}:${index}`))
      .filter((id) => !cancelled.has(id))
    expect(started).toEqual(expected)
    expect(results.filter((value) => value === 'cancelled')).toHaveLength(6)
    expect(await queue.enqueue('runtime-a', 'terminal.send', async () => 'recovered')).toBe(
      'recovered'
    )
  })
})
