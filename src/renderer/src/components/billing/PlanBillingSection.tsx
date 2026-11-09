import { useState } from 'react'
import { CreditCard, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatCents } from './plans/plans-pricing'
import { cn } from '@/lib/utils'
import type {
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { openPlansPage } from './plans/plans-page-store'
import { PaymentIssueNotice } from './PaymentIssueNotice'
import { OverageControls, UsageSummary } from './PlanBillingUsage'
import { denyReasonCopy, openFailureCopy, overageFailureCopy } from './plan-billing-copy'
import { PlanStatusBadge } from './PlanStatusBadge'
import { useOrcaBillingStatus } from './use-orca-billing-status'

export function PlanBillingSection(): React.JSX.Element | null {
  const t = useTranslate()
  const { loading, result, refresh } = useOrcaBillingStatus(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (open: () => Promise<OrcaBillingOpenResult>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await open().catch((error: unknown): OrcaBillingOpenResult => ({
      status: 'failed',
      error: String(error)
    }))
    setBusy(false)
    setNotice(
      outcome.status === 'opened'
        ? t(
            'auto.components.billing.continueInBrowser',
            'Continue in your browser. This updates when you come back.'
          )
        : openFailureCopy(outcome, t)
    )
  }

  const setOverage = async (args: OrcaBillingOverageArgs): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await window.api.orcaProfiles
      .billingSetOverage(args)
      .catch((error: unknown): OrcaBillingOverageResult => ({
        status: 'failed',
        error: String(error)
      }))
    setBusy(false)
    if (outcome.status === 'ok') {
      refresh()
    } else {
      setNotice(overageFailureCopy(outcome, t))
    }
  }

  return (
    <PlanBillingView
      result={result}
      loading={loading}
      busy={busy}
      notice={notice}
      onRefresh={refresh}
      onPortal={() => void run(() => window.api.orcaProfiles.billingOpenPortal())}
      onSetOverage={(args) => void setOverage(args)}
      onSeePlans={() => openPlansPage('settings')}
    />
  )
}

export type PlanBillingViewProps = {
  result: OrcaBillingStatusResult | null
  loading: boolean
  busy: boolean
  notice: string | null
  onRefresh: () => void
  onPortal: () => void
  onSetOverage: (args: OrcaBillingOverageArgs) => void
  /** Opens the plans page (pricing, Checkout, Enterprise contact). */
  onSeePlans: () => void
}

export function PlanBillingView({
  result,
  loading,
  busy,
  notice,
  onRefresh,
  onPortal,
  onSetOverage,
  onSeePlans
}: PlanBillingViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (!result || result.status === 'unconfigured' || result.status === 'signed-out') {
    // The pane above already handles sign-in; billing stays out of builds without a service.
    return null
  }

  const header = (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {t('auto.components.billing.title', 'Plan & billing')}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={loading}
        onClick={onRefresh}
        aria-label={t('auto.components.billing.refresh', 'Refresh plan')}
      >
        <RefreshCw className={cn(loading && 'animate-spin')} />
      </Button>
    </div>
  )

  if (result.status === 'failed') {
    return (
      <div className="space-y-3 border-t border-border/60 pt-5">
        {header}
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.loadFailed', 'Could not load your plan. Try again.')}
        </p>
      </div>
    )
  }

  const entitlement = result.entitlement
  const hasPlan = entitlement.plan !== null && entitlement.status !== 'canceled'
  const monthlyCents = entitlement.offers?.team.monthlyPriceCentsPerSeat ?? null
  const teamPrice = monthlyCents === null ? null : formatCents(monthlyCents, locale)

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      {header}
      {hasPlan ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{entitlement.planLabel}</p>
            <span className="text-xs text-muted-foreground">
              {t('auto.components.billing.seatsInterval', '{{value0}} seats · {{value1}}', {
                value0: String(entitlement.seats),
                value1:
                  entitlement.interval === 'year'
                    ? t('auto.components.billing.annual', 'Annual')
                    : t('auto.components.billing.monthly', 'Monthly')
              })}
            </span>
            <PlanStatusBadge entitlement={entitlement} />
          </div>
          <UsageSummary entitlement={entitlement} />
          <OverageControls entitlement={entitlement} busy={busy} onSetOverage={onSetOverage} />
        </div>
      ) : null}

      <PaymentIssueNotice entitlement={entitlement} busy={busy} onUpdatePayment={onPortal} />

      {entitlement.reason && entitlement.payment.pastDueSince === null ? (
        <p className="text-xs text-muted-foreground">
          {denyReasonCopy(entitlement.reason, t, entitlement.canManageBilling)}
        </p>
      ) : null}

      {!hasPlan ? (
        <p className="text-sm text-pretty">
          {teamPrice
            ? t(
                'auto.components.billing.upsellLine',
                'Orca Cloud runs agents in hosted sandboxes. Team is {{value0}} per seat / month.',
                { value0: teamPrice }
              )
            : t(
                'auto.components.billing.upsellLineNoPrice',
                'Orca Cloud runs agents in hosted sandboxes for your whole team.'
              )}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {hasPlan ? null : (
          <Button type="button" size="sm" onClick={onSeePlans}>
            {t('auto.components.billing.upgrade.cta', 'See plans')}
          </Button>
        )}
        {hasPlan && entitlement.canManageBilling && entitlement.payment.pastDueSince === null ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onPortal}>
            {t('auto.components.billing.manageBilling', 'Manage billing')}
            <ExternalLink />
          </Button>
        ) : null}
        {hasPlan ? (
          <Button type="button" variant="ghost" size="sm" onClick={onSeePlans}>
            {t('auto.components.billing.comparePlans', 'Compare plans')}
          </Button>
        ) : null}
      </div>

      {!entitlement.canManageBilling ? (
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.askAdmin', 'Ask an org owner or admin to change the plan.')}
        </p>
      ) : null}

      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  )
}
