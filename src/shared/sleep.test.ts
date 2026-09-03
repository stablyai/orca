import { describe, expect, it, vi } from 'vitest'
import { sleep } from './sleep'

describe('sleep', () => {
  it('waits for a zero-delay timer', async () => {
    vi.useFakeTimers()
    try {
      const pending = sleep(0)

      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(0)
      await expect(pending).resolves.toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an already-aborted signal without starting a timer or listener', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
      controller.abort()

      await expect(sleep(100, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(addEventListener).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects on abort and cleans up its timer and listener', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
      const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = sleep(100, controller.signal)
      const listener = addEventListener.mock.calls[0]?.[1]

      expect(listener).toBeTypeOf('function')
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()

      const error = await pending.catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(removeEventListener).toHaveBeenCalledWith('abort', listener)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes its abort listener after the timer completes', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const addEventListener = vi.spyOn(controller.signal, 'addEventListener')
      const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = sleep(100, controller.signal)
      const listener = addEventListener.mock.calls[0]?.[1]

      await vi.advanceTimersByTimeAsync(100)
      await expect(pending).resolves.toBeUndefined()
      expect(removeEventListener).toHaveBeenCalledWith('abort', listener)
    } finally {
      vi.useRealTimers()
    }
  })
})
