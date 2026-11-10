// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'

import { useAppStore } from '@/store'
import { getLastBillingStatus, resetBillingSummary } from './billing-summary-store'
import { sampleTeam } from './plan-billing-fixtures'
import { useOrcaBillingStatus } from './use-orca-billing-status'

const teamA: OrcaBillingStatusResult = { status: 'ok', entitlement: { ...sampleTeam } }
const teamB: OrcaBillingStatusResult = {
  status: 'ok',
  entitlement: { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
}

type Pending = { resolve: (result: OrcaBillingStatusResult) => void }
let pending: Pending[] = []

/** Signs in as `user-1` acting for `orgId`, as the auth status would after a team pick. */
function setAccount(orgId: string): void {
  useAppStore.setState({
    orcaProfileAuthStatus: {
      activeProfileId: 'local-default',
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: {
        cloudProfileId: 'cloud-1',
        userId: 'user-1',
        email: 'ada@example.com',
        linkedAt: 0,
        activeOrgId: orgId
      }
    }
  })
}

beforeEach(() => {
  setAccount('team-a')
  pending = []
  resetBillingSummary()
  vi.stubGlobal('api', {
    orcaProfiles: {
      billingStatus: vi.fn(
        () =>
          new Promise<OrcaBillingStatusResult>((resolve) => {
            pending.push({ resolve })
          })
      )
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** What the auth subscriber does on a team switch: bump the generation, then re-render. */
function switchTeam(rerender: () => void, next: string): void {
  act(() => {
    setAccount(next)
    resetBillingSummary()
    rerender()
  })
}

describe('useOrcaBillingStatus on a team switch', () => {
  it('drops the previous team plan and reads the new team', async () => {
    const { result, rerender } = renderHook(() => useOrcaBillingStatus(true))
    await act(async () => pending[0].resolve(teamA))
    expect(result.current.result).toEqual(teamA)

    switchTeam(rerender, 'team-b')
    expect(result.current).toMatchObject({ loading: true, result: null })
    expect(pending).toHaveLength(2)

    await act(async () => pending[1].resolve(teamB))
    expect(result.current).toMatchObject({ loading: false, result: teamB })
    expect(getLastBillingStatus()).toEqual(teamB)
  })

  it('never shows or records an answer that started before the switch', async () => {
    const { result, rerender } = renderHook(() => useOrcaBillingStatus(true))
    expect(pending).toHaveLength(1)

    switchTeam(rerender, 'team-b')
    await act(async () => pending[0].resolve(teamA))
    expect(result.current).toMatchObject({ loading: true, result: null })
    expect(getLastBillingStatus()).toBeNull()

    await act(async () => pending[1].resolve(teamB))
    expect(result.current).toMatchObject({ loading: false, result: teamB })
  })

  it('re-reads when the generation moved while a read was in flight', async () => {
    const { result } = renderHook(() => useOrcaBillingStatus(true))
    // The account changed under the hook (e.g. reconnect) before its key re-rendered.
    act(() => resetBillingSummary())
    await act(async () => pending[0].resolve(teamA))
    expect(result.current.result).toBeNull()
    expect(getLastBillingStatus()).toBeNull()
    expect(pending).toHaveLength(2)

    await act(async () => pending[1].resolve(teamB))
    expect(result.current).toMatchObject({ loading: false, result: teamB })
  })
})

describe('useOrcaBillingStatus on a failed re-read', () => {
  it('keeps the last good plan when a focus re-read fails', async () => {
    const { result } = renderHook(() => useOrcaBillingStatus(true))
    await act(async () => pending[0].resolve(teamA))

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(pending).toHaveLength(2)
    await act(async () => pending[1].resolve({ status: 'failed', error: 'offline' }))

    expect(result.current).toMatchObject({ loading: false, result: teamA })
  })

  it('shows the failure when nothing was read yet', async () => {
    const { result } = renderHook(() => useOrcaBillingStatus(true))
    await act(async () => pending[0].resolve({ status: 'failed', error: 'offline' }))
    expect(result.current.result).toEqual({ status: 'failed', error: 'offline' })
  })
})
