import { describe, expect, it } from 'vitest'
import { settleComposerSubmit } from './composer-submit-cancellation'

describe('settleComposerSubmit', () => {
  it('drops a resolved preflight result after cancellation', async () => {
    let cancelled = false
    let resolvePreflight: (value: string) => void = () => undefined
    const preflight = new Promise<string>((resolve) => {
      resolvePreflight = resolve
    })
    const settlement = settleComposerSubmit(preflight, () => cancelled)

    cancelled = true
    resolvePreflight('stale result')

    await expect(settlement).resolves.toEqual({ status: 'cancelled' })
  })

  it('suppresses a rejected preflight after cancellation', async () => {
    let cancelled = false
    let rejectPreflight: (error: Error) => void = () => undefined
    const preflight = new Promise<string>((_resolve, reject) => {
      rejectPreflight = reject
    })
    const settlement = settleComposerSubmit(preflight, () => cancelled)

    cancelled = true
    rejectPreflight(new Error('late failure'))

    await expect(settlement).resolves.toEqual({ status: 'cancelled' })
  })

  it('preserves successful and failed results while active', async () => {
    const active = () => false

    await expect(settleComposerSubmit(Promise.resolve('ready'), active)).resolves.toEqual({
      status: 'completed',
      value: 'ready'
    })
    await expect(
      settleComposerSubmit(Promise.reject(new Error('failure')), active)
    ).rejects.toThrow('failure')
  })
})
