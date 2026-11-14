// The Settings rows that stand in for team, billing and Enterprise management, which live in the
// Orca Cloud web console. The desktop keeps only read-only status (the plan and its health, a
// failed payment) so the person knows when to go there.
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

export function TeamConsoleLink(): React.JSX.Element {
  const t = useTranslate()
  return (
    <CloudConsoleLinkRow
      section="team"
      label={t('settings.cloudConsole.team.title', 'Members and invites')}
      description={t(
        'settings.cloudConsole.team.description',
        'Invite teammates, change roles, remove members, or create a team.'
      )}
    />
  )
}

export function EnterpriseConsoleLink(): React.JSX.Element {
  const t = useTranslate()
  return (
    <CloudConsoleLinkRow
      section="enterprise"
      label={t('settings.cloudConsole.enterprise.title', 'Enterprise')}
      description={t(
        'settings.cloudConsole.enterprise.description',
        'Single sign-on, verified domains, directory sync, required two-factor and the audit log.'
      )}
    />
  )
}
