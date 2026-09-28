import { createStore } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKiroUsageSlice, type KiroUsageSlice } from './kiro-usage'

function createKiroStore() {
  return createStore<KiroUsageSlice>()((...a) => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the slice creator is declared against the whole AppState; this store holds only its own slice, which is all the code under test reads.
    ...createKiroUsageSlice(...(a as unknown as Parameters<typeof createKiroUsageSlice>))
  }))
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
