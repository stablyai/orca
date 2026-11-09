import { useState } from 'react'
import { CreditCard, ExternalLink, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  OrcaBillingDenyReason,
  OrcaBillingEntitlement,
  OrcaBillingOpenResult,
  OrcaBillingPlanId,
  OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { formatHours, includedUsagePercent, planBillingTone } from './plan-billing-format'
import { useOrcaBillingStatus } from './use-orca-billing-status'

// Display only: the billing service and Stripe own the real catalog and prices.
function planOptions(
  t: Translate
): { plan: OrcaBillingPlanId; label: string; price: string; hours: string }[] {
  return [
    {
      plan: 'pro',
      label: t('auto.components.billing.planPro', 'Pro'),
      price: t('auto.components.billing.pricePro', '$25/mo'),
      hours: '50'
    },
    {
      plan: 'max',
      label: t('auto.components.billing.planMax', 'Max'),
      price: t('auto.components.billing.priceMax', '$100/mo'),
      hours: '300'
    },
    {
      plan: 'team',
      label: t('auto.components.billing.planTeam', 'Team'),
      price: t('auto.components.billing.priceTeam', '$60/seat/mo'),
      hours: '150'
    }
  ]
}

function denyReasonCopy(reason: OrcaBillingDenyReason, t: Translate): string {
  switch (reason) {
    case 'no_subscription':
      return t('auto.components.billing.reasonNoPlan', 'Hosted sandboxes need a paid plan.')
    case 'subscription_inactive':
      return t(
        'auto.components.billing.reasonInactive',
        'Your plan is not active. Choose a plan to start sandboxes.'
      )
    case 'payment_past_due':
      return t(
        'auto.components.billing.reasonPastDue',
        'Your last payment failed. Update your payment method to start new sandboxes.'
      )
    case 'included_hours_exhausted':
      return t(
        'auto.components.billing.reasonExhausted',
        'You have used all included hours for this period.'
      )
    case 'overage_cap_reached':
      return t('auto.components.billing.reasonCap', 'You reached this period’s overage limit.')
  }
}

function statusLabel(status: string, t: Translate): string {
  switch (status) {
    case 'active':
      return t('auto.components.billing.statusActive', 'Active')
    case 'trialing':
      return t('auto.components.billing.statusTrial', 'Trial')
    case 'past_due':
      return t('auto.components.billing.statusPastDue', 'Payment due')
    case 'canceled':
      return t('auto.components.billing.statusCanceled', 'Canceled')
    default:
      return t('auto.components.billing.statusInactive', 'Inactive')
  }
}

function openFailureCopy(result: OrcaBillingOpenResult, t: Translate): string | null {
  switch (result.status) {
    case 'opened':
      return null
    case 'forbidden':
      return t(
        'auto.components.billing.openForbidden',
        'Only an org owner or admin can manage billing.'
      )
    case 'already-subscribed':
      return t(
        'auto.components.billing.openAlreadySubscribed',
        'This account already has a plan. Use Manage billing to change it.'
      )
    case 'no-billing-account':
      return t(
        'auto.components.billing.openNoAccount',
        'There is no billing account yet. Choose a plan first.'
      )
    case 'signed-out':
      return t('auto.components.billing.openSignedOut', 'Sign in to Orca again to manage billing.')
    case 'unconfigured':
      return t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')
    case 'failed':
      return t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
  }
}

function UsageSummary({ entitlement }: { entitlement: OrcaBillingEntitlement }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const renews = entitlement.period
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entitlement.period.end)
    : null
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">
          {t('auto.components.billing.hoursUsed', '{{value0}} of {{value1}} hours used', {
            value0: formatHours(entitlement.usedSeconds),
            value1: formatHours(entitlement.includedSeconds)
          })}
        </span>
        <span className="text-muted-foreground">
          {t('auto.components.billing.hoursLeft', '{{value0}} hours left', {
            value0: formatHours(entitlement.remainingIncludedSeconds)
          })}
        </span>
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        aria-label={t('auto.components.billing.usageLabel', 'Included hours used')}
      />
      <p className="text-xs text-muted-foreground">
        {renews
          ? entitlement.cancelAtPeriodEnd
            ? t('auto.components.billing.endsOn', 'Plan ends {{value0}}', {
                value0: renews
              })
            : t('auto.components.billing.renewsOn', 'Renews {{value0}}', {
                value0: renews
              })
          : null}
        {entitlement.overageSeconds > 0
          ? ` · ${t('auto.components.billing.overage', '{{value0}} overage hours this period', {
              value0: formatHours(entitlement.overageSeconds)
            })}`
          : null}
      </p>
    </div>
  )
}

export function PlanBillingSection(): React.JSX.Element | null {
  const t = useTranslate()
  const { loading, result, refresh } = useOrcaBillingStatus(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (key: string, open: () => Promise<OrcaBillingOpenResult>): Promise<void> => {
    setBusy(key)
    setNotice(null)
    const outcome = await open().catch((error: unknown): OrcaBillingOpenResult => ({
      status: 'failed',
      error: String(error)
    }))
    setBusy(null)
    setNotice(
      outcome.status === 'opened'
        ? t(
            'auto.components.billing.continueInBrowser',
            'Continue in your browser. This updates when you come back.'
          )
        : openFailureCopy(outcome, t)
    )
  }

  return (
    <PlanBillingView
      result={result}
      loading={loading}
      busy={busy !== null}
      notice={notice}
      onRefresh={refresh}
      onCheckout={(plan) =>
        void run(plan, () => window.api.orcaProfiles.billingOpenCheckout({ plan }))
      }
      onPortal={() => void run('portal', () => window.api.orcaProfiles.billingOpenPortal())}
    />
  )
}

export type PlanBillingViewProps = {
  result: OrcaBillingStatusResult | null
  loading: boolean
  busy: boolean
  notice: string | null
  onRefresh: () => void
  onCheckout: (plan: OrcaBillingPlanId) => void
  onPortal: () => void
}

export function PlanBillingView({
  result,
  loading,
  busy,
  notice,
  onRefresh,
  onCheckout,
  onPortal
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

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      {header}
      {hasPlan ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">{entitlement.planLabel}</p>
            {entitlement.seats > 1 ? (
              <span className="text-xs text-muted-foreground">
                {t('auto.components.billing.seats', '{{value0}} seats', {
                  value0: String(entitlement.seats)
                })}
              </span>
            ) : null}
            <Badge
              variant={
                tone === 'blocked' ? 'destructive' : tone === 'warning' ? 'secondary' : 'outline'
              }
            >
              {statusLabel(entitlement.status, t)}
            </Badge>
          </div>
          <UsageSummary entitlement={entitlement} />
        </div>
      ) : null}

      {entitlement.reason ? (
        <p className="text-xs text-muted-foreground">{denyReasonCopy(entitlement.reason, t)}</p>
      ) : null}

      {!hasPlan && entitlement.canManageBilling ? (
        <div className="grid gap-3 md:grid-cols-3">
          {planOptions(t).map((option) => (
            <div
              key={option.plan}
              className="flex flex-col gap-2 rounded-md border border-border/60 p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{option.label}</p>
                <p className="text-xs text-muted-foreground">{option.price}</p>
              </div>
              <p className="flex-1 text-xs text-muted-foreground">
                {option.plan === 'team'
                  ? t(
                      'auto.components.billing.teamHours',
                      '{{value0}} sandbox hours per seat, pooled',
                      { value0: option.hours }
                    )
                  : t('auto.components.billing.planHours', '{{value0}} sandbox hours per month', {
                      value0: option.hours
                    })}
              </p>
              <Button
                type="button"
                size="sm"
                variant={option.plan === 'pro' ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => onCheckout(option.plan)}
              >
                {t('auto.components.billing.upgrade', 'Upgrade')}
                <ExternalLink />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {hasPlan && entitlement.canManageBilling ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onPortal}>
          {t('auto.components.billing.manage', 'Manage billing')}
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
