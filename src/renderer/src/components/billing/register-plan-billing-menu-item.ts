import { CreditCard } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { registerAccountMenuItem } from '../sidebar/account-menu/account-menu-items'

/** Cloud capability flag that turns billing on per account (server-controlled rollout). */
export const BILLING_CAPABILITY = 'billing'

/** "Plan & billing" in the account menu: opens the Orca account settings, where the plan lives. */
export function registerPlanBillingMenuItem(): () => void {
  return registerAccountMenuItem({
    id: 'orca.plan-billing',
    label: () => translate('auto.components.billing.menuItem', 'Plan & billing'),
    icon: CreditCard,
    order: 10,
    requiredCapability: BILLING_CAPABILITY,
    onSelect: () => {
      const state = useAppStore.getState()
      state.openSettingsTarget({ pane: 'orca-account', repoId: null })
      state.openSettingsPage()
    }
  })
}
