import { Cloud, CreditCard, Users } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { registerAccountMenuItem } from '../sidebar/account-menu/account-menu-items'
import {
  getBillingSummary,
  refreshBillingSummary,
  resetBillingSummary,
  subscribeBillingSummary
} from './billing-summary-store'
import { openPlansPage } from './plans/plans-page-store'
import { openTeamPage } from './team/team-page-store'

/** Cloud capability flag that turns billing on per account (server-controlled rollout). */
export const BILLING_CAPABILITY = 'billing'

const UPGRADE_ITEM_ID = 'orca.upgrade'

/**
 * Account menu: "Team" opens the Team page; "Plan & billing" opens the plans page. Accounts
 * without a plan also get "Upgrade to Orca Cloud" at the top of the group.
 */
export function registerPlanBillingMenuItem(): () => void {
  const registerBilling = (): (() => void) =>
    registerAccountMenuItem({
      id: 'orca.plan-billing',
      label: () => translate('auto.components.billing.menuItem', 'Plan & billing'),
      icon: CreditCard,
      order: 11,
      requiredCapability: BILLING_CAPABILITY,
      onSelect: () => openPlansPage('account-menu')
    })
  let disposeBilling: (() => void) | null = registerBilling()
  const disposeTeam = registerAccountMenuItem({
    id: 'orca.team',
    label: () => translate('auto.components.billing.team.menuItem', 'Team'),
    icon: Users,
    order: 10,
    requiredCapability: BILLING_CAPABILITY,
    onSelect: () => openTeamPage()
  })

  let disposeUpgrade: (() => void) | null = null
  const syncUpgrade = (): void => {
    // Only a known "no plan" shows it: never flash an upsell at a paying team while loading.
    const show = getBillingSummary().subscribed === false
    // One entry at a time: "Upgrade to Orca Cloud" replaces "Plan & billing" until there is a plan.
    if (show && disposeBilling) {
      disposeBilling()
      disposeBilling = null
    } else if (!show && !disposeBilling) {
      disposeBilling = registerBilling()
    }
    if (show && !disposeUpgrade) {
      disposeUpgrade = registerAccountMenuItem({
        id: UPGRADE_ITEM_ID,
        label: () => translate('auto.components.billing.upgrade.menuItem', 'Upgrade to Orca Cloud'),
        icon: Cloud,
        order: 9,
        tone: 'accent',
        requiredCapability: BILLING_CAPABILITY,
        onSelect: () => openPlansPage('account-menu')
      })
    } else if (!show && disposeUpgrade) {
      disposeUpgrade()
      disposeUpgrade = null
    }
  }
  const unsubscribeSummary = subscribeBillingSummary(syncUpgrade)

  // Re-read when the signed-in account or its org changes; billing-flagged accounts only.
  let lastKey: string | null = null
  const onAuth = (): void => {
    const auth = useAppStore.getState().orcaProfileAuthStatus
    const enabled =
      auth?.state === 'connected' && auth.capabilities?.flags[BILLING_CAPABILITY] === true
    const key = enabled ? `${auth?.cloud?.userId}:${auth?.cloud?.activeOrgId ?? ''}` : null
    if (key !== lastKey) {
      lastKey = key
      resetBillingSummary()
      if (key) {
        void refreshBillingSummary(true)
      }
    }
  }
  // Back from Stripe (Checkout, the Portal, or 3-D Secure after the in-app wait ended): the
  // plan may have changed even if no billing view is open.
  const disposeReturn = globalThis.window?.api?.orcaProfiles?.onBillingReturn?.(() => {
    void refreshBillingSummary(true)
  })
  const unsubscribeAuth = useAppStore.subscribe(onAuth)
  onAuth()

  return () => {
    disposeBilling?.()
    disposeTeam()
    disposeUpgrade?.()
    unsubscribeSummary()
    unsubscribeAuth()
    disposeReturn?.()
  }
}
