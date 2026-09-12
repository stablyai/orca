import { afterEach, expect, it, vi } from 'vitest'
import {
  createSliceStore,
  makeStatus,
  stubRuntimeEnvironmentApi
} from './runtime-status-slice-test-fixture'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from './runtime-status'

afterEach(() => {
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.unstubAllGlobals()
})

// #19647: a failed status.get dials its own fresh socket, so a refresh must not overwrite a
// recorded live verdict with null — that retires the host's session-tabs mirror and dims its
// still-live rows on a fault the client could not even ask through.
it('preserves a recorded live verdict when a refresh probe fails', async () => {
  const getStatus = vi.fn().mockRejectedValue(new Error('closed'))
  stubRuntimeEnvironmentApi({ getStatus })
  const store = createSliceStore()
  const cached = makeStatus()
  store.getState().setRuntimeEnvironmentStatus('env-a', { status: cached, checkedAt: 1 })

  const reachable = await store.getState().refreshRuntimeEnvironmentStatus('env-a')

  expect(reachable).toBe(false)
  expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBe(cached)
})

it('records null on a first-contact refresh failure, so host coverage completes', async () => {
  stubRuntimeEnvironmentApi({ getStatus: vi.fn().mockRejectedValue(new Error('closed')) })
  const store = createSliceStore()

  expect(await store.getState().refreshRuntimeEnvironmentStatus('env-a')).toBe(false)
  expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBe(null)
})
