import { afterEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => {
  const state: { status: unknown } = { status: null }
  return state
})
const openCloudConsole = vi.hoisted(() => vi.fn())
const openPlansDialog = vi.hoisted(() => vi.fn())
vi.mock('@/lib/orca-cloud/open-cloud-console', () => ({ openCloudConsole }))
vi.mock('./plans/plans-dialog-store', () => ({ openPlansDialog }))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({ orcaProfileAuthStatus: auth.status }),
    subscribe: () => () => {}
  }
}))

import {
  getRegisteredAccountMenuItems,
  selectVisibleAccountMenuItems
} from '../sidebar/account-menu/account-menu-items'
import { getBillingReadInFlight, recordBillingStatus } from './billing-summary-store'
import { sampleTeam } from './plan-billing-fixtures'
import { BILLING_CAPABILITY, registerPlanBillingMenuItem } from './register-plan-billing-menu-item'

const asRole = (role: string) => ({
  activeProfileId: 'p1',
  configured: true,
  state: 'connected' as const,
  persistence: 'encrypted' as const,
  cloud: { cloudProfileId: 'c1', userId: 'u1', email: 'e', activeOrgId: 'org-1', linkedAt: 0 },
  organizations: [{ orgId: 'org-1', name: 'Eval', role }],
  capabilities: { flags: { [BILLING_CAPABILITY]: true }, refreshedAt: 0 }
})

const visible = (role = 'Owner', orcaCloudEnabled = true): string[] =>
  selectVisibleAccountMenuItems(
    getRegisteredAccountMenuItems(),
    asRole(role),
    orcaCloudEnabled
  ).map((entry) => entry.id)

afterEach(() => {
  auth.status = null
  vi.unstubAllGlobals()
  recordBillingStatus({ status: 'signed-out' })
  openCloudConsole.mockReset()
  openPlansDialog.mockReset()
})

describe('account menu billing items', () => {
  it('registers Team and Plan & billing behind the billing capability', () => {
    const dispose = registerPlanBillingMenuItem()
    expect(
      selectVisibleAccountMenuItems(
        getRegisteredAccountMenuItems(),
        {
          activeProfileId: 'p1',
          configured: true,
          state: 'connected',
          persistence: 'encrypted',
          capabilities: { flags: {}, refreshedAt: 0 }
        },
        true
      ).map((item) => item.id)
    ).toEqual(['orca.team'])
    expect(visible()).toEqual(['orca.team', 'orca.plan-billing'])
    expect(visible('Admin')).toEqual(['orca.team', 'orca.plan-billing'])
    // Members get the read-only plans dialog (the console itself refuses them).
    expect(visible('Member')).toEqual(['orca.team', 'orca.plan-billing'])
    const plans = getRegisteredAccountMenuItems().find((item) => item.id === 'orca.plan-billing')
    plans?.onSelect()
    expect(openPlansDialog).toHaveBeenCalledTimes(1)
    expect(openCloudConsole).not.toHaveBeenCalled()
    dispose()
    expect(getRegisteredAccountMenuItems()).toHaveLength(0)
  })

  it('hides every Orca Cloud item while the rollout flag is off', () => {
    const dispose = registerPlanBillingMenuItem()
    recordBillingStatus({
      status: 'ok',
      entitlement: { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
    })
    expect(visible()).toContain('orca.upgrade')
    expect(visible('Owner', false)).toEqual([])
    expect(visible('Member', false)).toEqual([])
    dispose()
  })

  it('adds an accent upgrade item only once billing says there is no plan', () => {
    const dispose = registerPlanBillingMenuItem()
    expect(visible()).not.toContain('orca.upgrade')
    recordBillingStatus({
      status: 'ok',
      entitlement: { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
    })
    expect(visible()).toEqual(['orca.upgrade', 'orca.team'])
    expect(visible('Member')).toEqual(['orca.team', 'orca.plan-billing'])
    expect(getRegisteredAccountMenuItems().find((item) => item.id === 'orca.upgrade')?.tone).toBe(
      'accent'
    )
    recordBillingStatus({ status: 'ok', entitlement: sampleTeam })
    expect(visible()).not.toContain('orca.upgrade')
    dispose()
  })

  it('opens the team console page from the Team item', () => {
    const dispose = registerPlanBillingMenuItem()
    getRegisteredAccountMenuItems()
      .find((item) => item.id === 'orca.team')
      ?.onSelect()
    expect(openCloudConsole).toHaveBeenCalledWith('team')
    dispose()
  })

  it('re-reads billing when main asks (cloud workspace started, or the usage poll)', async () => {
    let requestRefresh: (() => void) | null = null
    const billingStatus = vi.fn(async () => ({ status: 'ok', entitlement: sampleTeam }))
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          billingStatus,
          onBillingRefreshRequested: (callback: () => void) => {
            requestRefresh = callback
            return () => {
              requestRefresh = null
            }
          }
        }
      }
    })
    auth.status = {
      state: 'connected',
      cloud: { userId: 'u1', activeOrgId: 'o1' },
      capabilities: { flags: { [BILLING_CAPABILITY]: true }, refreshedAt: 0 }
    }
    const dispose = registerPlanBillingMenuItem()
    await vi.waitFor(() => expect(billingStatus).toHaveBeenCalledTimes(1))
    await getBillingReadInFlight()
    // Forced: a read seconds ago must not swallow the request.
    requestRefresh!()
    await vi.waitFor(() => expect(billingStatus).toHaveBeenCalledTimes(2))
    dispose()
    expect(requestRefresh).toBeNull()
  })

  it('ignores refresh requests for accounts without billing', () => {
    let requestRefresh: (() => void) | null = null
    const billingStatus = vi.fn()
    vi.stubGlobal('window', {
      api: {
        orcaProfiles: {
          billingStatus,
          onBillingRefreshRequested: (callback: () => void) => {
            requestRefresh = callback
            return () => {}
          }
        }
      }
    })
    const dispose = registerPlanBillingMenuItem()
    requestRefresh!()
    expect(billingStatus).not.toHaveBeenCalled()
    dispose()
  })
})
