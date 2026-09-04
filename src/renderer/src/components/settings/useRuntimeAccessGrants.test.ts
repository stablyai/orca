// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { useRuntimeAccessGrants } from './useRuntimeAccessGrants'

type Grant = { deviceId: string; name: string; createdAt: number; lastSeenAt: number | null }

const grant = (deviceId: string): Grant => ({
  deviceId,
  name: deviceId,
  createdAt: 0,
  lastSeenAt: null
})

const mocks = {
  listRuntimeAccessGrants: vi.fn(),
  revokeRuntimeAccess: vi.fn()
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { mobile: mocks }
  })
}

describe('useRuntimeAccessGrants', () => {
  beforeEach(() => {
    mocks.listRuntimeAccessGrants
      .mockReset()
      .mockResolvedValue({ grants: [grant('a'), grant('b')] })
    mocks.revokeRuntimeAccess.mockReset().mockResolvedValue({ revoked: true })
    installApi()
  })

  it('drops the revoked grant and notifies the caller', async () => {
    const onGrantRevoked = vi.fn()
    const { result } = renderHook(() => useRuntimeAccessGrants({ onGrantRevoked }))
    await waitFor(() => expect(result.current.grants).toHaveLength(2))

    await act(async () => {
      await result.current.revoke(grant('a'))
    })

    expect(result.current.grants.map((g) => g.deviceId)).toEqual(['b'])
    expect(onGrantRevoked).toHaveBeenCalledWith('a')
    expect(result.current.revokingGrantId).toBeNull()
  })

  // Why: a reload in flight when the revoke lands still held the live loadId, so its stale
  // response wrote the revoked grant back into the list.
  it('does not let an in-flight reload resurrect a revoked grant', async () => {
    const onGrantRevoked = vi.fn()
    const { result } = renderHook(() => useRuntimeAccessGrants({ onGrantRevoked }))
    await waitFor(() => expect(result.current.grants).toHaveLength(2))

    let releaseReload!: (value: { grants: Grant[] }) => void
    mocks.listRuntimeAccessGrants.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseReload = resolve
      })
    )

    await act(async () => {
      void result.current.reload()
      await Promise.resolve()
    })

    await act(async () => {
      await result.current.revoke(grant('a'))
    })
    expect(result.current.grants.map((g) => g.deviceId)).toEqual(['b'])

    // The held reload now answers with the pre-revocation list.
    await act(async () => {
      releaseReload({ grants: [grant('a'), grant('b')] })
      await Promise.resolve()
    })

    expect(result.current.grants.map((g) => g.deviceId)).toEqual(['b'])
    expect(result.current.isLoading).toBe(false)
  })
})
