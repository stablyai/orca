// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../shared/orca-profiles/orca-profiles'
import {
  ORCA_CLOUD_AVAILABLE_CAPABILITY,
  orcaCloudEnabledFor,
  setOrcaCloudEnabledForTests,
  useOrcaCloudEnabled
} from './useOrcaCloudEnabled'

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'p1',
  configured: true,
  state: 'local',
  persistence: 'none'
}

function connected(available: boolean): OrcaProfileAuthStatus {
  return {
    ...signedOut,
    state: 'connected',
    persistence: 'encrypted',
    capabilities: { flags: { [ORCA_CLOUD_AVAILABLE_CAPABILITY]: available }, refreshedAt: 0 }
  }
}

afterEach(() => {
  cleanup()
  setOrcaCloudEnabledForTests(null)
  useAppStore.setState({ orcaProfileAuthStatus: null })
})

describe('orcaCloudEnabledFor', () => {
  it('is off by default: no status, signed out, or no capability', () => {
    expect(orcaCloudEnabledFor(null)).toBe(false)
    expect(orcaCloudEnabledFor(signedOut)).toBe(false)
    expect(orcaCloudEnabledFor(connected(false))).toBe(false)
  })

  it('follows the account capability', () => {
    expect(orcaCloudEnabledFor(connected(true))).toBe(true)
  })

  it('lets the build decide when main forces it', () => {
    expect(orcaCloudEnabledFor({ ...signedOut, orcaCloudForced: true })).toBe(true)
    expect(orcaCloudEnabledFor({ ...connected(true), orcaCloudForced: false })).toBe(false)
  })
})

describe('useOrcaCloudEnabled', () => {
  it('updates with the stored auth status', () => {
    const { result } = renderHook(() => useOrcaCloudEnabled())
    expect(result.current).toBe(false)
    act(() => useAppStore.setState({ orcaProfileAuthStatus: connected(true) }))
    expect(result.current).toBe(true)
    act(() => useAppStore.setState({ orcaProfileAuthStatus: signedOut }))
    expect(result.current).toBe(false)
  })
})
