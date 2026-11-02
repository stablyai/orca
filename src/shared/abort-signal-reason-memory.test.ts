import { expect, it } from 'vitest'
import { waitForPromiseWithSignal } from './abort-signal-reason'

async function cancelCallers(work: Promise<void>): Promise<WeakRef<Uint8Array>[]> {
  const references: WeakRef<Uint8Array>[] = []
  for (let index = 0; index < 32; index += 1) {
    const payload = new Uint8Array(1024 * 1024)
    references.push(new WeakRef(payload))
    const controller = new AbortController()
    const waiting = waitForPromiseWithSignal(work, controller.signal).catch(() => undefined)
    controller.abort(new Error('request cancelled', { cause: payload }))
    await waiting
  }
  return references
}

it('collects cancelled callers and their payloads before shared work finishes', async () => {
  let finish = (): void => {}
  const work = new Promise<void>((resolve) => {
    finish = resolve
  })
  const anchor = waitForPromiseWithSignal(work, new AbortController().signal)
  const references = await cancelCallers(work)
  await new Promise<void>((resolve) => setImmediate(resolve))
  if (!globalThis.gc) {
    throw new Error('Run this regression with --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  const retained = references.filter((reference) => reference.deref() !== undefined).length
  finish()
  await anchor
  expect(retained).toBe(0)
})
