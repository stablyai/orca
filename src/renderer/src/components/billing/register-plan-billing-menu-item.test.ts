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

describe('Plan & billing account menu item', () => {
  it('registers behind the billing capability and opens Orca account settings', () => {
    const dispose = registerPlanBillingMenuItem()
    const item = getRegisteredAccountMenuItems().find((entry) => entry.id === 'orca.plan-billing')
    expect(item?.requiredCapability).toBe(BILLING_CAPABILITY)
    expect(item?.label()).toBe('Plan & billing')
    item?.onSelect()
    expect(openSettingsTarget).toHaveBeenCalledWith({
      pane: 'orca-account',
      repoId: null
    })
    expect(openSettingsPage).toHaveBeenCalled()

    const visible = (flags: Record<string, boolean>): string[] =>
      selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), {
        activeProfileId: 'p1',
        configured: true,
        state: 'connected',
        persistence: 'encrypted',
        capabilities: { flags, refreshedAt: 0 }
      }).map((entry) => entry.id)
    expect(visible({})).not.toContain('orca.plan-billing')
    expect(visible({ [BILLING_CAPABILITY]: true })).toContain('orca.plan-billing')
    expect(selectVisibleAccountMenuItems(getRegisteredAccountMenuItems(), null)).toHaveLength(0)

    dispose()
    expect(getRegisteredAccountMenuItems()).toHaveLength(0)
  })
})
