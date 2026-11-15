import { describe, expect, it } from 'vitest'
import { PrioritySemaphore } from './priority-semaphore'

describe('PrioritySemaphore', () => {
  it('removes an aborted waiter without consuming the next permit', async () => {
    const sem = new PrioritySemaphore(1)
    const release = await sem.acquire(0)
    const controller = new AbortController()
    const reason = new Error('canceled')
    const waiting = sem.acquire(0, controller.signal)

    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    release()

    const nextRelease = await sem.acquire(0)
    nextRelease()
  })
})
