import { useState } from 'react'
import { CreditCard, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
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
import { invalidateOrcaCloudBilling } from '../new-workspace/orca-cloud-billing-cache'

export function PlanBillingSection(): React.JSX.Element | null {
  const t = useTranslate()
  const { loading, result, refresh } = useOrcaBillingStatus(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PlanBillingNotice | null>(null)
  const [userRefreshing, setUserRefreshing] = useState(false)
  const [overageFailures, setOverageFailures] = useState(0)

  const run = async (open: () => Promise<OrcaBillingOpenResult>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const outcome = await open().catch((error: unknown): OrcaBillingOpenResult => ({
      status: 'failed',
      error: String(error)
    }))
    setBusy(false)
    const failure = openFailureCopy(outcome, t)
    setNotice(
      failure
        ? { kind: 'error', text: failure }
        : {
            kind: 'info',
            text: t(
              'auto.components.billing.continueInBrowser',
              'Continue in your browser. This updates when you come back.'
            )
          }
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
      // The Run-on picker's Orca Cloud row reads a shared copy; overage/cap just changed it.
      invalidateOrcaCloudBilling()
    } else {
      const failure = overageFailureCopy(outcome, t)
      setNotice(failure ? { kind: 'error', text: failure } : null)
      setOverageFailures((count) => count + 1)
    }
  }

  return (
    <PlanBillingView
      result={result}
      loading={loading}
      refreshing={userRefreshing}
      busy={busy}
      notice={notice}
      onRefresh={() => {
        // Spin only for a refresh the user asked for, and long enough to be seen (review M16).
        setUserRefreshing(true)
        refresh()
        window.setTimeout(() => setUserRefreshing(false), 400)
      }}
      onPortal={() => void run(() => window.api.orcaProfiles.billingOpenPortal())}
      overageFailures={overageFailures}
      onSetOverage={(args) => void setOverage(args)}
      onSeePlans={() => openPlansPage('settings')}
    />
  )
}

export type PlanBillingNotice = { kind: 'error' | 'info'; text: string }

export type PlanBillingViewProps = {
  result: OrcaBillingStatusResult | null
  loading: boolean
  /** A user-requested refresh is running; background re-reads (window focus) never spin. */
  refreshing?: boolean
  busy: boolean
  notice: PlanBillingNotice | null
  onRefresh: () => void
  onPortal: () => void
  onSetOverage: (args: OrcaBillingOverageArgs) => void
  overageFailures?: number
  /** Opens the plans page (pricing, Checkout, Enterprise contact). */
  onSeePlans: () => void
}

export function PlanBillingView({
  result,
  loading,
  refreshing = false,
  busy,
  notice,
  onRefresh,
  onPortal,
  onSetOverage,
  overageFailures = 0,
  onSeePlans
}: PlanBillingViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (!result) {
    return loading ? (
      <div className="space-y-3" aria-busy>
        <span className="sr-only">
          {t('auto.components.billing.loading', 'Loading your plan…')}
        </span>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-16 w-full" />
      </div>
    ) : null
  }
  if (result.status === 'unconfigured') {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'auto.components.billing.unconfigured',
          'Billing isn’t available in this build of Orca.'
        )}
      </p>
    )
  }
  if (result.status === 'signed-out') {
    // The Orca Cloud panes show the sign-in prompt before this renders.
    return null
  }

  // Settings › Orca Cloud › Plan & billing owns the title; the refresh sits with the plan it reloads.
  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-disabled={refreshing || undefined}
      onClick={refreshing ? undefined : onRefresh}
      aria-label={t('auto.components.billing.refresh', 'Refresh plan')}
    >
      <RefreshCw className={cn(refreshing && 'motion-safe:animate-spin')} />
    </Button>
  )

  if (result.status === 'failed') {
    return (
      <div className="space-y-3">
        <InlineError
          title={t('auto.components.billing.loadFailedTitle', 'Couldn’t load your plan')}
          retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
          onRetry={onRefresh}
          retrying={loading}
        />
      </div>
    )
  }

  const entitlement = result.entitlement
  const hasPlan = entitlement.plan !== null && entitlement.status !== 'canceled'
  const monthlyCents = entitlement.offers?.team.monthlyPriceCentsPerSeat ?? null
  const teamPrice = monthlyCents === null ? null : formatCents(monthlyCents, locale)

  return (
    <div className="space-y-4">
      <PaymentIssueNotice entitlement={entitlement} busy={busy} onUpdatePayment={onPortal} />
      {hasPlan ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{entitlement.planLabel}</p>
            <span className="text-xs text-muted-foreground">
              {entitlement.interval === 'year'
                ? t('auto.components.billing.seatsAnnual', '{{count}} seats · Annual', {
                    count: entitlement.seats,
                    defaultValue_one: '{{count}} seat · Annual'
                  })
                : t('auto.components.billing.seatsMonthly', '{{count}} seats · Monthly', {
                    count: entitlement.seats,
                    defaultValue_one: '{{count}} seat · Monthly'
                  })}
            </span>
            <PlanStatusBadge entitlement={entitlement} />
            <span className="ml-auto">{refreshButton}</span>
          </div>
          <UsageSummary entitlement={entitlement} />
          {/* Overage is moot while sandboxes are suspended for a failed payment. */}
          {entitlement.payment.suspendRunning ? null : (
            <OverageControls
              entitlement={entitlement}
              busy={busy}
              failures={overageFailures}
              onSetOverage={onSetOverage}
            />
          )}
        </div>
      ) : null}

      {/* The overage card carries the cap-reached hint for admins; don't repeat it here. */}
      {hasPlan &&
      entitlement.reason &&
      entitlement.payment.pastDueSince === null &&
      !(entitlement.reason === 'overage_cap_reached' && entitlement.canManageBilling) ? (
        <p className="text-xs text-muted-foreground">
          {denyReasonCopy(entitlement.reason, t, entitlement.canManageBilling)}
        </p>
      ) : null}

      {!hasPlan ? (
        <p className="text-sm text-muted-foreground text-pretty">
          {teamPrice
            ? t(
                'auto.components.billing.upsellLine2',
                'Orca Cloud runs agents in sandboxes. Team is {{value0}} per seat per month.',
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onPortal}
          >
            {t('auto.components.billing.manageBilling', 'Manage billing')}
            <ExternalLink />
          </Button>
        ) : null}
        {hasPlan ? (
          <Button type="button" variant="ghost" size="sm" onClick={onSeePlans}>
            {t('auto.components.billing.comparePlans', 'Compare plans')}
          </Button>
        ) : (
          <span className="ml-auto">{refreshButton}</span>
        )}
      </div>

      {/* The payment alert already says who to ask; don't ask twice. */}
      {!entitlement.canManageBilling && entitlement.payment.pastDueSince === null ? (
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.askAdmin2', 'Ask an owner or admin to change the plan.')}
        </p>
      ) : null}

      {notice?.kind === 'error' ? (
        <InlineError tone="error" title={notice.text} />
      ) : notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}
