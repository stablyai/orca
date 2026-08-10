import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: false }
}))

describe('store renderer memory registration', () => {
  it('publishes count and pool-specific store hypotheses', async () => {
    const { collectRendererMemoryProfile } = await import('./renderer-memory-profile')
    await import('@/store')

    const profile = collectRendererMemoryProfile()

    expect(Object.keys(profile.counts).some((key) => key.startsWith('store.'))).toBe(true)
    expect(profile.onHeapHeuristicByCategoryKB).toHaveProperty('storeKB.onHeapHeuristicKB')
    expect(profile.externalHeuristicByCategoryKB).toHaveProperty('storeKB.externalHeuristicKB')
  })
})
