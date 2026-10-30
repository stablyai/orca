import { getEventListeners } from 'node:events'
import { expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import { sharedPromiseSettlementWaiters } from './promise-settlement-waiters'

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

it('detaches cancelled callers from shared stalled work while another caller waits', async () => {
  let finish = (_value: number): void => {}
  const work = new Promise<number>((resolve) => {
    finish = resolve
  })
  const observed = vi.spyOn(work, 'then')
  const anchorController = new AbortController()
  const anchor = waitForPromiseWithSignal(work, anchorController.signal)
  for (let index = 0; index < 100; index += 1) {
    const controller = new AbortController()
    const cancelled = waitForPromiseWithSignal(work, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  }
  expect(observed).toHaveBeenCalledOnce()
  expect(sharedPromiseSettlementWaiters(work).waiterCount).toBe(1)
  finish(42)
  await expect(anchor).resolves.toBe(42)
  expect(sharedPromiseSettlementWaiters(work).waiterCount).toBe(0)
  expect(getEventListeners(anchorController.signal, 'abort')).toHaveLength(0)
})

it('observes shared work only once for callers already aborted', async () => {
  const work = new Promise<void>(() => {})
  const observed = vi.spyOn(work, 'then')
  const signal = AbortSignal.abort(new Error('cancelled'))
  for (let index = 0; index < 100; index += 1) {
    await expect(waitForPromiseWithSignal(work, signal)).rejects.toThrow('cancelled')
  }
  expect(observed).toHaveBeenCalledOnce()
  expect(sharedPromiseSettlementWaiters(work).waiterCount).toBe(0)
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

it('returns work directly when no cancellation was requested', () => {
  const work = Promise.resolve(42)
  expect(waitForPromiseWithSignal(work)).toBe(work)
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
