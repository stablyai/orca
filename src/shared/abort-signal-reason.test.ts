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
