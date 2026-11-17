// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setArchiveTtlDaysForTest, useArchiveTtlDays } from './archive-ttl'

function stubConfig(getConfig: () => Promise<unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { orcaCloudWorkspace: { getConfig } }
  })
}

afterEach(() => {
  cleanup()
  setArchiveTtlDaysForTest(null)
})

describe('useArchiveTtlDays', () => {
  it('reads the archive TTL from the control plane’s config once and shares it', async () => {
    const getConfig = vi.fn(async () => ({ idleSleepMinutes: 15, archiveTtlDays: 14 }))
    stubConfig(getConfig)
    const first = renderHook(() => useArchiveTtlDays())
    await waitFor(() => expect(first.result.current).toBe(14))
    const second = renderHook(() => useArchiveTtlDays())
    expect(second.result.current).toBe(14)
    expect(getConfig).toHaveBeenCalledOnce()
  })

  it('stays null for an older control plane or offline, and asks again next time', async () => {
    const getConfig = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ idleSleepMinutes: 15 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ idleSleepMinutes: 15, archiveTtlDays: 30 })
    stubConfig(getConfig)
    const first = renderHook(() => useArchiveTtlDays())
    await act(async () => {})
    expect(getConfig).toHaveBeenCalledTimes(1)
    expect(first.result.current).toBeNull()
    first.unmount()
    renderHook(() => useArchiveTtlDays()).unmount()
    await act(async () => {})
    expect(getConfig).toHaveBeenCalledTimes(2)
    const third = renderHook(() => useArchiveTtlDays())
    await waitFor(() => expect(third.result.current).toBe(30))
  })
})
