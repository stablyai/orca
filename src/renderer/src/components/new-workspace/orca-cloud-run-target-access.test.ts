import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import {
  getOrcaCloudPick,
  toOrcaCloudRunTargetAccess,
  orcaCloudCanStart
} from './orca-cloud-run-target-access'

const openPlansDialog = vi.fn()
vi.mock('@/components/billing/plans/plans-dialog-store', () => ({
  openPlansDialog: () => openPlansDialog()
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
    openPlansDialog.mockReset()
  })

  it('carries the role on no plan, so members are not sent to plans they cannot buy', () => {
    const owner = toOrcaCloudRunTargetAccess(denied('no_subscription', true))
    const member = toOrcaCloudRunTargetAccess(denied('subscription_inactive', false))
    expect(owner).toEqual({ state: 'no-plan', lapsed: false, canManageBilling: true })
    expect(member).toEqual({ state: 'no-plan', lapsed: true, canManageBilling: false })
    expect(getOrcaCloudPick(member)).toEqual({ kind: 'blocked' })
    expect(openPlansDialog).not.toHaveBeenCalled()
  })

  it('sends an owner or admin to billing in the browser', () => {
    const pick = getOrcaCloudPick(toOrcaCloudRunTargetAccess(denied('no_subscription', true)))
    expect(pick.kind).toBe('act')
    if (pick.kind === 'act') {
      pick.run()
    }
    expect(openPlansDialog).toHaveBeenCalledTimes(1)
  })

  it('blocks members at the spend cap and lets owners act', () => {
    const member = toOrcaCloudRunTargetAccess(denied('overage_cap_reached', false))
    expect(member).toEqual({ state: 'out-of-hours', cause: 'cap', canManageBilling: false })
    expect(getOrcaCloudPick(member)).toEqual({ kind: 'blocked' })
    const owner = toOrcaCloudRunTargetAccess(denied('overage_cap_reached', true))
    expect(getOrcaCloudPick(owner).kind).toBe('act')
  })
})

describe('orcaCloudCanStart', () => {
  it('is false only while something blocks a start', () => {
    expect(orcaCloudCanStart(undefined)).toBe(true)
    expect(orcaCloudCanStart({ state: 'entitled', remainingSeconds: 60 })).toBe(true)
    expect(orcaCloudCanStart({ state: 'loading' })).toBe(true)
    expect(orcaCloudCanStart({ state: 'no-plan', lapsed: false, canManageBilling: false })).toBe(
      false
    )
    expect(orcaCloudCanStart({ state: 'out-of-hours', cause: 'cap', canManageBilling: true })).toBe(
      false
    )
    expect(orcaCloudCanStart({ state: 'payment-issue', canManageBilling: false })).toBe(false)
    expect(orcaCloudCanStart({ state: 'signed-out' })).toBe(false)
  })
})
