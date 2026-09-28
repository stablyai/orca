import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKiroUsageSlice } from './kiro-usage'
import type { AppState } from '../types'

function createKiroStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createKiroUsageSlice(...(args as Parameters<typeof createKiroUsageSlice>))
  ) as unknown as StoreApi<AppState>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createKiroUsageSlice', () => {
  it('forwards the force flag to the main-process refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { kiroUsage: { refresh } } })
    const store = createKiroStore()

    await store.getState().refreshKiroUsage(true)
    expect(refresh).toHaveBeenCalledWith(true)
  })

  it('swallows a rejected refresh so the caller spinner still clears', async () => {
    vi.stubGlobal('window', {
      api: { kiroUsage: { refresh: vi.fn().mockRejectedValue(new Error('boom')) } }
    })
    const store = createKiroStore()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(store.getState().refreshKiroUsage()).resolves.toBeUndefined()
    errorSpy.mockRestore()
  })
})
