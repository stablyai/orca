import { describe, expect, it } from 'vitest'
import { terminalSetupStreamLifecycle } from './runtime-terminal-setup'

describe('Setup stream ownership', () => {
  it.each([20, 200])(
    'releases %i failed host attempts and fences late predecessor cleanup',
    async (count) => {
      const streams = Array.from({ length: count }, (_, index) =>
        terminalSetupStreamLifecycle(
          `failed-${index}`,
          () => true,
          () => {},
          () => {}
        )
      )
      await Promise.all(
        streams.map(async (stream) => {
          await expect(stream.retain(Promise.reject(new Error('unavailable')))).rejects.toThrow(
            'unavailable'
          )
        })
      )
      expect(streams.filter((stream) => stream.isActive())).toHaveLength(0)
      const old = terminalSetupStreamLifecycle(
        'replacement',
        () => true,
        () => {},
        () => {}
      )
      const late = Promise.withResolvers<{ unsubscribe: () => void }>()
      const retained = old.retain(late.promise)
      const next = terminalSetupStreamLifecycle(
        'replacement',
        () => true,
        () => {},
        () => {}
      )
      late.resolve({ unsubscribe: () => {} })
      ;(await retained).unsubscribe()
      expect(next.isActive()).toBe(true)
      next.callbacks.onClose()
      expect(next.isActive()).toBe(false)
    }
  )
})
