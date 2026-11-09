import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({}) } }))

describe('shouldContinueInterruptedTurn', () => {
  it('continues only a remote agent whose last status was working', async () => {
    const { shouldContinueInterruptedTurn } = await import('./cold-restore-resume-startup')
    expect(shouldContinueInterruptedTurn({ state: 'working' }, 'env-1')).toBe(true)
    expect(shouldContinueInterruptedTurn({ state: 'waiting' }, 'env-1')).toBe(false)
    expect(shouldContinueInterruptedTurn({ state: 'working' }, null)).toBe(false)
    expect(shouldContinueInterruptedTurn(null, 'env-1')).toBe(false)
  })
})
