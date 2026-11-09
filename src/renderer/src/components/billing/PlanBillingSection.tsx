import { useState } from 'react'
import { CreditCard, ExternalLink, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  OrcaBillingInterval,
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { EnterpriseOffer, TeamOffer } from './PlanBillingOffers'
import { OverageControls, UsageSummary } from './PlanBillingUsage'
import {
  denyReasonCopy,
  openFailureCopy,
  overageFailureCopy,
  statusLabel
} from './plan-billing-copy'
import { planBillingTone } from './plan-billing-format'
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
      onCheckout={({ interval, seats }) =>
        void run(() =>
          window.api.orcaProfiles.billingOpenCheckout({ plan: 'team', interval, seats })
        )
      }
      onPortal={() => void run(() => window.api.orcaProfiles.billingOpenPortal())}
      onSetOverage={(args) => void setOverage(args)}
      onContactSales={(url) => void window.api.shell.openUrl(url)}
    />
  )
}

export type PlanBillingViewProps = {
  result: OrcaBillingStatusResult | null
  loading: boolean
  busy: boolean
  notice: string | null
  onRefresh: () => void
  onCheckout: (args: { interval: OrcaBillingInterval; seats: number }) => void
  onPortal: () => void
  onSetOverage: (args: OrcaBillingOverageArgs) => void
  onContactSales: (url: string) => void
}

export function PlanBillingView({
  result,
  loading,
  busy,
  notice,
  onRefresh,
  onCheckout,
  onPortal,
  onSetOverage,
  onContactSales
}: PlanBillingViewProps): React.JSX.Element | null {
  const t = useTranslate()
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
  const tone = planBillingTone(entitlement)
  const hasPlan = entitlement.plan !== null && entitlement.status !== 'canceled'
  const offers = entitlement.offers

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
            <Badge
              variant={
                tone === 'blocked' ? 'destructive' : tone === 'warning' ? 'secondary' : 'outline'
              }
            >
              {statusLabel(entitlement.status, t)}
            </Badge>
          </div>
          <UsageSummary entitlement={entitlement} />
          <OverageControls
            // Re-seed the cap field when the saved cap changes.
            key={entitlement.overage.spendCapCents}
            entitlement={entitlement}
            busy={busy}
            onSetOverage={onSetOverage}
          />
        </div>
      ) : null}

      {entitlement.reason ? (
        <p className="text-xs text-muted-foreground">{denyReasonCopy(entitlement.reason, t)}</p>
      ) : null}

      {!hasPlan && offers ? (
        <div className="grid gap-3 md:grid-cols-2">
          {entitlement.canManageBilling ? (
            <TeamOffer offers={offers} busy={busy} onCheckout={onCheckout} />
          ) : null}
          <EnterpriseOffer offers={offers} onContactSales={onContactSales} />
        </div>
      ) : null}

      {hasPlan && entitlement.canManageBilling ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onPortal}>
          {t('auto.components.billing.manageSeats', 'Manage seats & billing')}
          <ExternalLink />
        </Button>
      ) : null}

      {!entitlement.canManageBilling ? (
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.askAdmin', 'Ask an org owner or admin to change the plan.')}
        </p>
      ) : null}

      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  )
}
