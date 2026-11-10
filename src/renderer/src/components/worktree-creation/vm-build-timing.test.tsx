// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useVmBuildStepTimings } from './vm-build-timing'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('asks for the measured timing on every new build sheet, never for VM recipes', async () => {
  const getConfig = vi
    .fn()
    .mockResolvedValueOnce({
      idleSleepMinutes: 15,
      createTiming: { p50Ms: 3000, p95Ms: 9000, samples: 40 }
    })
    .mockResolvedValueOnce({
      idleSleepMinutes: 15,
      createTiming: { p50Ms: 5000, p95Ms: 9000, samples: 41 }
    })
  vi.stubGlobal('window', Object.assign(window, { api: { orcaCloudWorkspace: { getConfig } } }))

  const first = renderHook(() => useVmBuildStepTimings(true))
  await waitFor(() => expect(first.result.current.provision?.p50Ms).toBe(3000))
  first.unmount()

  const second = renderHook(() => useVmBuildStepTimings(true))
  // The last answer shows at once, then the fresh one replaces it.
  expect(second.result.current.provision?.p50Ms).toBe(3000)
  await waitFor(() => expect(second.result.current.provision?.p50Ms).toBe(5000))
  expect(getConfig).toHaveBeenCalledTimes(2)

  renderHook(() => useVmBuildStepTimings(false))
  expect(getConfig).toHaveBeenCalledTimes(2)
})
