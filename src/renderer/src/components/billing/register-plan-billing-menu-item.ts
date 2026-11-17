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
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import { openPlansDialog } from './plans/plans-dialog-store'

/** Cloud capability flag that turns billing on per account (server-controlled rollout). */
export const BILLING_CAPABILITY = 'billing'

const UPGRADE_ITEM_ID = 'orca.upgrade'

/**
 * Account menu: "Plan & billing" opens the plans dialog (status and plans, then the web console);
 * "Team" opens the console. Owners and admins of a team without a plan get "Upgrade to Orca Cloud"
 * (the same dialog) in place of Plan & billing; members keep Plan & billing, read-only.
 */
export function registerPlanBillingMenuItem(): () => void {
  const registerBilling = (hideFromTeamAdmin: boolean): (() => void) =>
    registerAccountMenuItem({
      id: 'orca.plan-billing',
      label: () => translate('auto.components.billing.menuItem', 'Plan & billing'),
      icon: CreditCard,
      order: 11,
      orcaCloud: true,
      requiredCapability: BILLING_CAPABILITY,
      hideFromTeamAdmin,
      onSelect: openPlansDialog
    })
  let billingHiddenFromAdmins = false
  let disposeBilling: () => void = registerBilling(false)
  const disposeTeam = registerAccountMenuItem({
    id: 'orca.team',
    label: () => translate('auto.components.billing.team.menuItem', 'Team'),
    icon: Users,
    order: 10,
    orcaCloud: true,
    // Team management doesn't depend on billing or a flag: any signed-in account can open it.
    requiresSignIn: true,
    onSelect: () => void openCloudConsole('team')
  })

  let disposeUpgrade: (() => void) | null = null
  const syncUpgrade = (): void => {
    // Only a known "no plan" shows it: never flash an upsell at a paying team while loading.
    const show = getBillingSummary().subscribed === false
    // One entry at a time for admins: "Upgrade to Orca Cloud" replaces "Plan & billing".
    if (show !== billingHiddenFromAdmins) {
      billingHiddenFromAdmins = show
      disposeBilling()
      disposeBilling = registerBilling(show)
    }
    if (show && !disposeUpgrade) {
      disposeUpgrade = registerAccountMenuItem({
        id: UPGRADE_ITEM_ID,
        label: () => translate('auto.components.billing.upgrade.menuItem', 'Upgrade to Orca Cloud'),
        icon: Cloud,
        order: 9,
        orcaCloud: true,
        tone: 'accent',
        requiredCapability: BILLING_CAPABILITY,
        requiresTeamAdmin: true,
        onSelect: openPlansDialog
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
  // Main asks after a cloud workspace is created or woken, and every 30 min while one runs, so a
  // team crossing a usage level mid-session is alerted. Billing-flagged accounts only.
  const disposeRefreshRequest = globalThis.window?.api?.orcaProfiles?.onBillingRefreshRequested?.(
    () => {
      if (lastKey) {
        void refreshBillingSummary(true)
      }
    }
  )
  const unsubscribeAuth = useAppStore.subscribe(onAuth)
  onAuth()

  return () => {
    disposeBilling()
    disposeTeam()
    disposeUpgrade?.()
    unsubscribeSummary()
    unsubscribeAuth()
    disposeReturn?.()
    disposeRefreshRequest?.()
  }
}
