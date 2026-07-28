import { expect, it, vi } from 'vitest'
import { createTerminalTabCloseSessionPersistenceQueue } from './terminal-tab-close-session-persistence'

it('retries failed post-ack persistence before writing a newer snapshot', async () => {
  vi.useFakeTimers()
  try {
    const enqueue = createTerminalTabCloseSessionPersistenceQueue([25])
    const order: string[] = []
    const first = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('first-failed')
        throw new Error('disk busy')
      })
      .mockImplementationOnce(async () => {
        order.push('first-retried')
      })
    const second = vi.fn(async () => {
      order.push('second')
    })

    const firstWrite = enqueue(first)
    const secondWrite = enqueue(second)
    await vi.advanceTimersByTimeAsync(25)
    await Promise.all([firstWrite, secondWrite])

    expect(order).toEqual(['first-failed', 'first-retried', 'second'])
  } finally {
    vi.useRealTimers()
  }
})
