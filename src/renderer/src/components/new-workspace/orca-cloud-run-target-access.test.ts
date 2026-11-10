import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { getOrcaCloudPick, toOrcaCloudRunTargetAccess } from './orca-cloud-run-target-access'

const openPlansPage = vi.fn()
vi.mock('@/components/billing/plans/plans-page-store', () => ({
  openPlansPage: (source: string) => openPlansPage(source)
}))
const requestOrcaCloudAfterCheckout = vi.fn()
vi.mock('@/lib/orca-cloud-after-checkout', () => ({
  requestOrcaCloudAfterCheckout: (intent: unknown) => requestOrcaCloudAfterCheckout(intent)
}))

function denied(
  reason: OrcaBillingEntitlement['reason'],
  canManageBilling: boolean
): Parameters<typeof toOrcaCloudRunTargetAccess>[0] {
  return {
    status: 'ok',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: access reads only these fields.
    entitlement: {
      canStartSandbox: false,
      remainingIncludedSeconds: 0,
      reason,
      canManageBilling
    } as OrcaBillingEntitlement
  }
}

describe('Orca Cloud run-target access by role', () => {
  beforeEach(() => {
    openPlansPage.mockReset()
    requestOrcaCloudAfterCheckout.mockReset()
  })

  it('carries the role on no plan, so members are not sent to plans they cannot buy', () => {
    const owner = toOrcaCloudRunTargetAccess(denied('no_subscription', true))
    const member = toOrcaCloudRunTargetAccess(denied('subscription_inactive', false))
    expect(owner).toEqual({ state: 'no-plan', lapsed: false, canManageBilling: true })
    expect(member).toEqual({ state: 'no-plan', lapsed: true, canManageBilling: false })
    expect(getOrcaCloudPick(member)).toEqual({ kind: 'blocked' })
    expect(openPlansPage).not.toHaveBeenCalled()
  })

  it('sends an owner or admin to plans and leaves a return-to-composer intent', () => {
    const pick = getOrcaCloudPick(toOrcaCloudRunTargetAccess(denied('no_subscription', true)))
    expect(pick.kind).toBe('act')
    if (pick.kind === 'act') {
      pick.run()
    }
    expect(requestOrcaCloudAfterCheckout).toHaveBeenCalledWith({ kind: 'composer' })
    expect(openPlansPage).toHaveBeenCalledWith('sandbox')
  })

  it('blocks members at the spend cap and lets owners act', () => {
    const member = toOrcaCloudRunTargetAccess(denied('overage_cap_reached', false))
    expect(member).toEqual({ state: 'out-of-hours', cause: 'cap', canManageBilling: false })
    expect(getOrcaCloudPick(member)).toEqual({ kind: 'blocked' })
    const owner = toOrcaCloudRunTargetAccess(denied('overage_cap_reached', true))
    expect(getOrcaCloudPick(owner).kind).toBe('act')
  })
})
