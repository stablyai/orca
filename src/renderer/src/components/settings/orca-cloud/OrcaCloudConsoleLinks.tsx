// The Settings row for billing, which is managed in the Orca Cloud web console; team and admin are
// one row on the Account page (AccountTeamAdminRow). The desktop keeps only read-only status (the
// plan and its health, a failed payment) and the plans dialog, which leads on to the console.
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import { PaymentIssueNotice } from '../../billing/PaymentIssueNotice'
import { PlanStatusBadge } from '../../billing/PlanStatusBadge'
import { openPlansDialog } from '../../billing/plans/plans-dialog-store'
import { useOrcaBillingStatus } from '../../billing/use-orca-billing-status'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'

/** Plan & billing: the plan and its health here; the plans dialog, then the console, for the rest. */
export function PlanBillingConsoleLink(): React.JSX.Element {
  const t = useTranslate()
  const billing = useOrcaBillingStatus(true)
  const entitlement = billing.result?.status === 'ok' ? billing.result.entitlement : null
  const plan = entitlement?.planLabel?.trim() || null
  return (
    <div className="space-y-3">
      {entitlement ? (
        <PaymentIssueNotice
          entitlement={entitlement}
          busy={false}
          onUpdatePayment={() => void openCloudConsole('billing')}
        />
      ) : null}
      <SettingsGroup>
        <SettingsRow
          label={
            <span className="flex flex-wrap items-center gap-2">
              {plan ?? t('auto.components.billing.title', 'Plan & billing')}
              {entitlement?.plan ? <PlanStatusBadge entitlement={entitlement} /> : null}
            </span>
          }
          description={t(
            'settings.cloudConsole.billing.descriptionPlans',
            'See your plan and compare plans, then change it, see invoices and update payment in your browser.'
          )}
          control={
            <Button type="button" variant="outline" size="sm" onClick={openPlansDialog}>
              {t('settings.cloudConsole.billing.viewPlans', 'View plans')}
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  )
}
