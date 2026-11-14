// The Settings row that stands in for billing management, which lives in the Orca Cloud web
// console; team and admin are one row on the Account page (AccountTeamAdminRow). The desktop keeps
// only read-only status (the plan and its health, a failed payment) so the person knows when to go.
import { useTranslate } from '@/i18n/use-translate'
import { openCloudConsole } from '@/lib/orca-cloud/open-cloud-console'
import { PaymentIssueNotice } from '../../billing/PaymentIssueNotice'
import { PlanStatusBadge } from '../../billing/PlanStatusBadge'
import { useOrcaBillingStatus } from '../../billing/use-orca-billing-status'
import { CloudConsoleLinkRow } from './CloudConsoleLinkRow'

/** Plan & billing: the plan and its health here; plans, usage, invoices and payment in the console. */
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
      <CloudConsoleLinkRow
        section="billing"
        label={
          <span className="flex flex-wrap items-center gap-2">
            {plan ?? t('auto.components.billing.title', 'Plan & billing')}
            {entitlement?.plan ? <PlanStatusBadge entitlement={entitlement} /> : null}
          </span>
        }
        description={t(
          'settings.cloudConsole.billing.description',
          'Change your plan, see sandbox hours and invoices, and update payment.'
        )}
      />
    </div>
  )
}
