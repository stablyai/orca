import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ orcaProfileAuthStatus: null }), subscribe: () => () => {} }
}))

import {
  getRegisteredAccountMenuItems,
  selectVisibleAccountMenuItems
} from '../sidebar/account-menu/account-menu-items'
import { recordBillingStatus } from './billing-summary-store'
import { sampleTeam } from './plan-billing-fixtures'
import { BILLING_CAPABILITY, registerPlanBillingMenuItem } from './register-plan-billing-menu-item'
import { getPlansPageState } from './plans/plans-page-store'
import { closeTeamPage, getTeamPageState } from './team/team-page-store'

const visible = (): string[] =>
  selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), {
    activeProfileId: 'p1',
    configured: true,
    state: 'connected',
    persistence: 'encrypted',
    capabilities: { flags: { [BILLING_CAPABILITY]: true }, refreshedAt: 0 }
  }).map((entry) => entry.id)

afterEach(() => {
  recordBillingStatus({ status: 'signed-out' })
  closeTeamPage()
})

describe('account menu billing items', () => {
  it('registers Team and Plan & billing behind the billing capability', () => {
    const dispose = registerPlanBillingMenuItem()
    expect(
      selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), {
        activeProfileId: 'p1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        capabilities: { flags: {}, refreshedAt: 0 }
      })
    ).toEqual([])
    expect(visible()).toEqual(['orca.team', 'orca.plan-billing'])
    const plans = getRegisteredAccountMenuItems().find((item) => item.id === 'orca.plan-billing')
    plans?.onSelect()
    expect(getPlansPageState()).toEqual({ open: true, source: 'account-menu' })
    dispose()
    expect(getRegisteredAccountMenuItems()).toHaveLength(0)
  })

  it('adds an accent upgrade item only once billing says there is no plan', () => {
    const dispose = registerPlanBillingMenuItem()
    expect(visible()).not.toContain('orca.upgrade')
    recordBillingStatus({
      status: 'ok',
      entitlement: { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
    })
    expect(visible()).toEqual(['orca.upgrade', 'orca.team', 'orca.plan-billing'])
    expect(getRegisteredAccountMenuItems().find((item) => item.id === 'orca.upgrade')?.tone).toBe(
      'accent'
    )
    recordBillingStatus({ status: 'ok', entitlement: sampleTeam })
    expect(visible()).not.toContain('orca.upgrade')
    dispose()
  })

  it('opens the Team page from the Team item', () => {
    const dispose = registerPlanBillingMenuItem()
    getRegisteredAccountMenuItems()
      .find((item) => item.id === 'orca.team')
      ?.onSelect()
    expect(getTeamPageState()).toEqual({ open: true, arrival: null })
    dispose()
  })
})
