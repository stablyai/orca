// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../index'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('can surface a refresh failure without changing existing callers', async () => {
  const refresh = vi.fn().mockRejectedValue(new Error('IPC unavailable'))
  vi.stubGlobal('api', { rateLimits: { refresh } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  await expect(useAppStore.getState().refreshRateLimits()).resolves.toBeUndefined()
  await expect(useAppStore.getState().refreshRateLimits({ throwOnError: true })).rejects.toThrow(
    'IPC unavailable'
  )
})

it('still applies successful quota snapshots', async () => {
  const state = createEmptyRateLimitState()
  vi.stubGlobal('api', { rateLimits: { refresh: vi.fn().mockResolvedValue(state) } })
  await useAppStore.getState().refreshRateLimits({ throwOnError: true })
  expect(useAppStore.getState().rateLimits).toEqual(state)
})
