import { expect, it } from 'vitest'
import { waitForPromiseWithSignal } from './abort-signal-reason'

it('observes work that rejects after its caller has already canceled', async () => {
  const controller = new AbortController()
  const reason = new Error('Caller canceled')
  controller.abort(reason)
  const work = new Promise<never>((_resolve, reject) => {
    queueMicrotask(() => reject(new Error('Late filesystem failure')))
  })

  await expect(waitForPromiseWithSignal(work, controller.signal)).rejects.toBe(reason)
  await new Promise<void>((resolve) => setImmediate(resolve))
})

it('allows synchronous cancellation before a cached settlement is delivered', async () => {
  const work = Promise.resolve(42)
  await expect(waitForPromiseWithSignal(work, new AbortController().signal)).resolves.toBe(42)
  const controller = new AbortController()
  const waiting = waitForPromiseWithSignal(work, controller.signal)
  controller.abort(new Error('cancelled'))
  await expect(waiting).rejects.toThrow('cancelled')
  await expect(waitForPromiseWithSignal(work, new AbortController().signal)).resolves.toBe(42)
})

it('preserves an abort queued between two callers of an already-settled promise', async () => {
  const work = Promise.resolve(42)
  const first = waitForPromiseWithSignal(work, new AbortController().signal)
  const controller = new AbortController()
  queueMicrotask(() => controller.abort(new Error('cancelled before this caller could read')))
  const second = waitForPromiseWithSignal(work, controller.signal)
  await expect(first).resolves.toBe(42)
  await expect(second).rejects.toThrow('cancelled before this caller could read')
})
