import { CreditCard, Users } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { registerAccountMenuItem } from '../sidebar/account-menu/account-menu-items'

/** Cloud capability flag that turns billing on per account (server-controlled rollout). */
export const BILLING_CAPABILITY = 'billing'

function openAccountSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'orca-account', repoId: null })
  state.openSettingsPage()
}

/** "Plan & billing" and "Team" in the account menu: both open the Orca account settings. */
export function registerPlanBillingMenuItem(): () => void {
  const disposeBilling = registerAccountMenuItem({
    id: 'orca.plan-billing',
    label: () => translate('auto.components.billing.menuItem', 'Plan & billing'),
    icon: CreditCard,
    order: 10,
    requiredCapability: BILLING_CAPABILITY,
    onSelect: openAccountSettings
  })
  const disposeTeam = registerAccountMenuItem({
    id: 'orca.team',
    label: () => translate('auto.components.billing.team.menuItem', 'Team'),
    icon: Users,
    order: 11,
    requiredCapability: BILLING_CAPABILITY,
    onSelect: openAccountSettings
  })
  return () => {
    disposeBilling()
    disposeTeam()
  }
}
