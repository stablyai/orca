import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import {
  ACCOUNT_BILLING_PLAN_ANCHOR,
  hasOrcaBillingAccount
} from '@/hooks/settings-navigation-orca-cloud-sections'
import { PlanBillingSection } from '../../billing/PlanBillingSection'
import { OrcaAccountSettingsPane } from '../accounts/orca/OrcaAccountSettingsPane'
import { SettingsGroupHeader } from '../section-layout/SettingsGroup'

/** The two parts of Account & billing under their headers; with no billing, just the account. */
export function AccountBillingLayout({
  account,
  billing
}: {
  account: React.ReactNode
  billing: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  // No billing (signed out, or an account without it): the page is just "Account", so no headers.
  if (!billing) {
    return <>{account}</>
  }
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SettingsGroupHeader
          className="px-0"
          title={t('settings.accountBilling.account', 'Account')}
        />
        {account}
      </div>
      {/* The page's second half: the same rule as under the page subtitle, then its header. */}
      <div
        id={ACCOUNT_BILLING_PLAN_ANCHOR}
        className="scroll-mt-4 space-y-4 border-t border-border pt-8"
      >
        <SettingsGroupHeader
          className="px-0"
          title={t('auto.components.billing.title', 'Plan & billing')}
        />
        {billing}
      </div>
    </div>
  )
}

/**
 * Neil: Account + Billing is one page in Orca Cloud builds. The account (who's signed in, Sign
 * out) leads; Plan & billing follows for signed-in, billing-enabled accounts. Signed out, the
 * account part already offers sign-in, so billing adds nothing rather than a second sign-in notice.
 */
export function OrcaAccountBillingPane(): React.JSX.Element {
  // The same rule the nav uses for its "Account & billing" / "Account" label.
  const showBilling = useAppStore(hasOrcaBillingAccount)
  return (
    <AccountBillingLayout
      account={<OrcaAccountSettingsPane />}
      billing={showBilling ? <PlanBillingSection /> : null}
    />
  )
}
