import { describe, expect, it, vi } from 'vitest'

const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ openSettingsTarget, openSettingsPage }) }
}))

import { registeredAccountMenuItemsForTest } from './account-menu-adapter'
import { BILLING_CAPABILITY, registerPlanBillingMenuItem } from './register-plan-billing-menu-item'

describe('Plan & billing account menu item', () => {
  it('registers behind the billing capability and opens Orca account settings', () => {
    const dispose = registerPlanBillingMenuItem()
    const item = registeredAccountMenuItemsForTest().find(
      (entry) => entry.id === 'orca.plan-billing'
    )
    expect(item?.requiredCapability).toBe(BILLING_CAPABILITY)
    expect(item?.label()).toBe('Plan & billing')
    item?.onSelect()
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'orca-account',
      repoId: null
    })
    expect(openSettingsPage).toHaveBeenCalled()
    dispose()
    expect(registeredAccountMenuItemsForTest()).toHaveLength(0)
  })
})
