import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatCents } from './plans/plans-pricing'
import {
  isOrcaCloudTrial,
  type OrcaBillingOpenResult,
  type OrcaBillingOverageArgs,
  type OrcaBillingOverageResult,
  type OrcaBillingStatusResult
} from '../../../../shared/orca-billing'
import { openPlansPage } from './plans/plans-page-store'
import { PaymentIssueNotice } from './PaymentIssueNotice'
import { OverageControls, UsageSummary } from './PlanBillingUsage'
import { denyReasonCopy, openFailureCopy, overageFailureCopy } from './plan-billing-copy'
import { PlanStatusBadge } from './PlanStatusBadge'
import { TrialPlanSummary } from './TrialPlanSummary'
import { useOrcaBillingStatus } from './use-orca-billing-status'
import { useAppStore } from '@/store/index'
import { usageAlertLevel } from '../../../../shared/orca-billing-usage-alerts'
import { BILLING_CAPABILITY } from './register-plan-billing-menu-item'
import { SettingsGroupHeader } from '@/components/settings/section-layout/SettingsGroup'
import { PlanBillingUsageHistory } from './PlanBillingUsageHistory'
import {
  usePlanBillingUsageHistory,
  type PlanBillingUsageState
} from './use-plan-billing-usage-history'

export function PlanBillingSection(): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { loading, result, refresh } = useOrcaBillingStatus(true)
  // Only billing-flagged accounts get a skeleton; others hear "unconfigured" and show nothing.
  const billingFlagged = useAppStore(
    (state) => state.orcaProfileAuthStatus?.capabilities?.flags[BILLING_CAPABILITY] === true
  )
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<PlanBillingNotice | null>(null)
  const [overageFailures, setOverageFailures] = useState(0)
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const entitlement = result?.status === 'ok' ? result.entitlement : null
  const hasPlan =
    entitlement !== null && entitlement.plan !== null && entitlement.status !== 'canceled'
  // Re-read the history with every billing read (it re-reads on window focus).
  const usage = usePlanBillingUsageHistory(
    hasPlan && cloud
      ? `${cloud.userId}:${cloud.activeOrgId ?? ''}|${entitlement.usedSeconds}`
      : null,
    cloud?.activeOrgId ?? null,
    cloud?.userId ?? null,
    entitlement?.canManageBilling === true
  )

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
      // One shared store: this re-read also updates the Run-on picker's Orca Cloud row.
      refresh()
    } else {
      const maxCap =
        result?.status === 'ok' ? (result.entitlement.offers?.team.maxSpendCapCents ?? null) : null
      const failure = overageFailureCopy(outcome, t, maxCap, locale)
      setNotice(failure ? { kind: 'error', text: failure } : null)
      setOverageFailures((count) => count + 1)
    }
  }

  return (
    <PlanBillingView
      result={result}
      loading={loading && (result !== null || billingFlagged)}
      busy={busy}
      notice={notice}
      teamName={cloud?.activeOrgName ?? null}
      usage={usage.state}
      onRetryUsage={usage.retry}
      onRefresh={refresh}
      onPortal={() => void run(() => window.api.orcaProfiles.billingOpenPortal())}
      overageFailures={overageFailures}
      onSetOverage={(args) => void setOverage(args)}
      onSeePlans={() => openPlansPage('settings')}
    />
  )
}

const noop = (): void => {}

export type PlanBillingNotice = { kind: 'error' | 'info'; text: string }

export type PlanBillingViewProps = {
  result: OrcaBillingStatusResult | null
  loading: boolean
  busy: boolean
  notice: PlanBillingNotice | null
  /** The active team's name, for the "<Team> · Team plan" title. */
  teamName?: string | null
  /** The last 30 days; absent (fixtures without history) renders nothing. */
  usage?: PlanBillingUsageState
  onRetryUsage?: () => void
  /** Re-reads the plan after a failed load (the page otherwise re-reads on window focus). */
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
  busy,
  notice,
  teamName = null,
  usage,
  onRetryUsage = noop,
  onRefresh,
  onPortal,
  onSetOverage,
  overageFailures = 0,
  onSeePlans
}: PlanBillingViewProps): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  if (!result) {
    return loading ? <PlanBillingSkeleton /> : null
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
  // The one-time trial stands in for a plan until one starts (spec T1).
  const onTrial = !hasPlan && isOrcaCloudTrial(entitlement)
  const trialUsedUp = onTrial && entitlement.trial?.exhausted === true
  const monthlyCents = entitlement.offers?.team.monthlyPriceCentsPerSeat ?? null
  const teamPrice = monthlyCents === null ? null : formatCents(monthlyCents, locale)

  return (
    <div className="space-y-4">
      <PaymentIssueNotice entitlement={entitlement} busy={busy} onUpdatePayment={onPortal} />
      {hasPlan ? (
        <div className="space-y-6">
          <div className="space-y-4">
            <SettingsGroupHeader
              className="px-0"
              title={
                teamName
                  ? t('auto.components.billing.teamPlanTitle', '{{team}} · {{plan}} plan', {
                      team: teamName,
                      plan: entitlement.planLabel
                    })
                  : t('auto.components.billing.planTitle', '{{plan}} plan', {
                      plan: entitlement.planLabel
                    })
              }
              description={
                entitlement.interval === 'year'
                  ? t('auto.components.billing.seatsAnnual', '{{count}} seats · Annual', {
                      count: entitlement.seats,
                      defaultValue_one: '{{count}} seat · Annual'
                    })
                  : t('auto.components.billing.seatsMonthly', '{{count}} seats · Monthly', {
                      count: entitlement.seats,
                      defaultValue_one: '{{count}} seat · Monthly'
                    })
              }
              action={<PlanStatusBadge entitlement={entitlement} />}
            />
            <UsageSummary entitlement={entitlement} />
          </div>
          {usage ? <PlanBillingUsageHistory state={usage} onRetry={onRetryUsage} /> : null}
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

      {onTrial ? <TrialPlanSummary entitlement={entitlement} onChoosePlan={onSeePlans} /> : null}

      {/* Admins already read these above: the overage card's cap-reached hint, and the usage
          alert's out-of-hours sentence. */}
      {(hasPlan || entitlement.reason === 'trial_unavailable') &&
      entitlement.reason &&
      entitlement.payment.pastDueSince === null &&
      !(
        entitlement.canManageBilling &&
        (entitlement.reason === 'overage_cap_reached' ||
          (entitlement.reason === 'included_hours_exhausted' &&
            usageAlertLevel(entitlement) === 100))
      ) ? (
        <p className="text-xs text-muted-foreground">
          {denyReasonCopy(entitlement.reason, t, entitlement.canManageBilling)}
        </p>
      ) : null}

      {!hasPlan && !onTrial ? (
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
        {hasPlan || onTrial ? null : (
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
          // Members have no other action here, so it gets the button's chrome (and its alignment).
          <Button
            type="button"
            variant={entitlement.canManageBilling ? 'ghost' : 'outline'}
            size="sm"
            onClick={onSeePlans}
          >
            {t('auto.components.billing.comparePlans', 'Compare plans')}
          </Button>
        ) : null}
      </div>

      {/* The payment alert already says who to ask; don't ask twice. */}
      {!entitlement.canManageBilling &&
      entitlement.payment.pastDueSince === null &&
      !trialUsedUp ? (
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

/** Same rows as a loaded plan (header, plan line, usage, overage card) so nothing jumps in. */
function PlanBillingSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label={t('auto.components.billing.loadingPlan', 'Loading your plan…')}
    >
      <div className="flex items-center gap-2">
        <Skeleton shape="circle" className="size-4" />
        <Skeleton shape="small" className="h-4 w-16" />
        <Skeleton shape="small" className="h-3 w-28" />
      </div>
      <div className="space-y-2">
        <div className="flex justify-between gap-3">
          <Skeleton shape="small" className="h-3 w-56" />
          <Skeleton shape="small" className="h-3 w-28" />
        </div>
        <Skeleton shape="circle" className="h-2 w-full" />
        <Skeleton shape="small" className="h-3 w-40" />
      </div>
      <Skeleton shape="card" className="h-20 w-full" />
      <Skeleton className="h-8 w-32" />
    </div>
  )
}
