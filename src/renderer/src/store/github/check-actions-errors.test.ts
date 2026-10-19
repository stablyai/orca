import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '../slices/github-slice-test-harness'

const pending: PRCheckDetail[] = [{ name: 'Build', status: 'queued', conclusion: null, url: null }]
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('checks provider error policy', () => {
  it.each([true, false])(
    'shares one failed read with strict caller first=%s',
    async (strictFirst) => {
      const store = createTestStore()
      const upstream = Promise.withResolvers<PRCheckDetail[]>()
      const error = new Error('offline')
      mockApi.gh.prChecks.mockReturnValueOnce(upstream.promise)
      const fetch = (throwOnError: boolean): Promise<PRCheckDetail[]> =>
        store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, { throwOnError })
      const first = fetch(strictFirst)
      const second = fetch(!strictFirst)
      const settled = Promise.allSettled([first, second])
      upstream.reject(error)
      const results = await settled
      expect(results[strictFirst ? 0 : 1]).toEqual({ status: 'rejected', reason: error })
      expect(results[strictFirst ? 1 : 0]).toEqual({ status: 'fulfilled', value: [] })
      expect(mockApi.gh.prChecks).toHaveBeenCalledOnce()
      expect(store.getState().checksCache).toEqual({})
    }
  )

  it('preserves the good cache for default callers while strict callers observe errors and recover', async () => {
    const store = createTestStore()
    mockApi.gh.prChecks.mockResolvedValueOnce(pending)
    await store.getState().fetchPRChecks('/repo', 1, 'main', 'sha')
    const error = new Error('offline')
    mockApi.gh.prChecks.mockRejectedValue(error)
    await expect(
      store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, {
        force: true,
        throwOnError: true
      })
    ).rejects.toThrow(error)
    await expect(
      store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, {
        force: true
      })
    ).resolves.toEqual(pending)
    expect(Object.values(store.getState().checksCache).map((entry) => entry.data)).toEqual([
      pending
    ])
    mockApi.gh.prChecks.mockResolvedValueOnce([])
    await expect(
      store.getState().fetchPRChecks('/repo', 1, 'main', 'sha', undefined, {
        force: true,
        throwOnError: true
      })
    ).resolves.toEqual([])
  })
})
