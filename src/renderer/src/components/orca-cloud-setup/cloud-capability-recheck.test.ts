import { describe, expect, it, vi } from 'vitest'
import { recheckCloudCapability } from './cloud-capability-recheck'

describe('recheckCloudCapability (PAID-TEAM-CHOOSE-PLAN)', () => {
  it('asks auth for fresh capabilities before re-reading availability', async () => {
    const order: string[] = []
    let resolveAuth: () => void = () => undefined
    const refreshAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('auth-start')
          resolveAuth = () => {
            order.push('auth-done')
            resolve()
          }
        })
    )
    const rereadAvailability = vi.fn(() => {
      order.push('availability')
    })
    const prefetchBilling = vi.fn()
    const pending = recheckCloudCapability({ refreshAuth, prefetchBilling, rereadAvailability })
    await Promise.resolve()
    // Availability waits for auth: reading it first would show the stale "isn't turned on".
    expect(rereadAvailability).not.toHaveBeenCalled()
    resolveAuth()
    await pending
    expect(order).toEqual(['auth-start', 'auth-done', 'availability'])
    expect(prefetchBilling).toHaveBeenCalledTimes(1)
  })

  it('still re-reads availability when auth or billing fails, and never throws', async () => {
    const rereadAvailability = vi.fn()
    await expect(
      recheckCloudCapability({
        refreshAuth: () => Promise.reject(new Error('offline')),
        prefetchBilling: () => {
          throw new Error('billing down')
        },
        rereadAvailability
      })
    ).resolves.toBeUndefined()
    expect(rereadAvailability).toHaveBeenCalledTimes(1)
  })
})
