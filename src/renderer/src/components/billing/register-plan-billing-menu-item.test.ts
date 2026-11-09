import { describe, expect, it, vi } from 'vitest'

const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ openSettingsTarget, openSettingsPage }) }
}))

import {
  getRegisteredAccountMenuItems,
  selectVisibleAccountMenuItems
} from '../sidebar/account-menu/account-menu-items'
import { BILLING_CAPABILITY, registerPlanBillingMenuItem } from './register-plan-billing-menu-item'

describe('Plan & billing and Team account menu items', () => {
  it('register behind the billing capability and open Orca account settings', () => {
    const dispose = registerPlanBillingMenuItem()
    const items = getRegisteredAccountMenuItems()
    expect(items.map((item) => [item.id, item.label(), item.requiredCapability])).toEqual([
      ['orca.plan-billing', 'Plan & billing', BILLING_CAPABILITY],
      ['orca.team', 'Team', BILLING_CAPABILITY]
    ])
    items[1]?.onSelect()
    expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'orca-account', repoId: null })
    expect(openSettingsPage).toHaveBeenCalled()

    const visible = (flags: Record<string, boolean>): string[] =>
      selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), {
        activeProfileId: 'p1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        capabilities: { flags, refreshedAt: 0 }
      }).map((entry) => entry.id)
    expect(visible({})).toEqual([])
    expect(visible({ [BILLING_CAPABILITY]: true })).toEqual(['orca.plan-billing', 'orca.team'])

    dispose()
    expect(getRegisteredAccountMenuItems()).toHaveLength(0)
  })
})
