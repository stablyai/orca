import { expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { createFakeBridgePortPair } from '../../mobile/src/mobile-web-shell/bridge/bridge-port-pair-test-harness'

async function abandonCaller(pair: ReturnType<typeof createFakeBridgePortPair>) {
  const captured = { bytes: new Uint8Array(512 * 1024) }
  const weak = new WeakRef(captured)
  const controller = new AbortController()
  const answer = pair.client.sendRequest('status.get', undefined, {
    signal: controller.signal,
    beforeSend: () => {
      if (captured.bytes.length !== 512 * 1024) {
        throw new Error('caller identity changed')
      }
    }
  })
  await pair.flush()
  controller.abort()
  await answer.then(
    () => {
      throw new Error('abandoned caller fulfilled')
    },
    (error: unknown) => {
      if (!(error instanceof Error) || error.name !== 'AbortError') {
        throw error
      }
    }
  )
  await pair.flush()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  return weak
}

it.each([1, 10])(
  'collects %s abandoned page callers while physical work and B remain anchored',
  async (count) => {
    if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
      throw new Error('The test runner must enable --expose-gc')
    }
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const survivor = pair.client.sendRequest('status.get')
    const weak = []
    try {
      for (let index = 0; index < count; index++) {
        weak.push(await abandonCaller(pair))
      }
      expect(pair.rpc.requests).toHaveLength(count + 1)
      expect(pair.readToShell().filter((frame) => frame.type === 'cancel')).toHaveLength(count)
      // Use the existing exposed-GC contract: advance turns before collection, without dereferencing in between.
      for (let round = 0; round < 5; round++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect(weak.map((reference) => reference.deref())).toEqual(Array(count).fill(undefined))
      pair.rpc.requests[0]!.resolve({ id: 'B', ok: true, result: 'survives' })
      await pair.flush()
      expect(await survivor).toEqual({ id: 'B', ok: true, result: 'survives' })
      for (const request of pair.rpc.requests.slice(1)) {
        request.resolve({ id: 'late', ok: true, result: 'obsolete' })
      }
      await pair.flush()
      expect(pair.readToPage().filter((frame) => frame.type === 'reply')).toHaveLength(1)
    } finally {
      pair.client.close()
      pair.host.dispose()
      await survivor.catch(() => {})
    }
  }
)
