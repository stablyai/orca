import { useEffect, useState } from 'react'
import { Progress } from '@/components/ui/progress'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  isOrcaCloudTrial,
  type OrcaBillingEntitlement,
  type OrcaBillingInterval,
  type OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { PlanStatusBadge } from '../PlanStatusBadge'
import type { PlanBillingNotice } from '../PlanBillingSection'
import { seatCountLabel } from '../team/team-copy'
import { formatHours, formatHoursUsed, includedUsagePercent } from '../plan-billing-format'
import {
  includedUsageTone,
  sandboxHoursCount,
  sandboxHoursLeftLine,
  usageWarningLine
} from '../plan-billing-usage-copy'
import { TrialPlanSummary } from '../TrialPlanSummary'
import { EnterprisePlanCard } from './EnterprisePlanCard'
import { PlansLoadError, PlansSkeleton, ValueProps } from './PlansViewParts'
import { PlansIntervalToggle } from './PlansIntervalToggle'
import { TeamPlanCard, type TeamPlanCardMode } from './TeamPlanCard'
import { annualSavingsPercent, clampSeats } from './plans-pricing'
import { resolvePlansModel } from './plans-model'
import type { OrcaPlanCatalogResult } from '../../../../../shared/orca-billing-plans'

export type PlansViewProps = {
  result: OrcaBillingStatusResult | null
  /** Billing's plan catalog (GET /v1/plans); null while it loads. */
  catalog: OrcaPlanCatalogResult | null
  busy: boolean
  notice: PlanBillingNotice | null
  /** Seats Checkout will bill: org members, or 1 for a personal account. */
  seats: number
  onCheckout: (args: { planId: string; interval: OrcaBillingInterval; seats: number }) => void
  /** "Copy link" on the checkout button: the Checkout URL it would open (absent: no chevron). */
  checkoutLink?: (args: {
    planId: string
    interval: OrcaBillingInterval
    seats: number
  }) => Promise<string | null>
  onManage: () => void
  onContactSales: (url: string) => void
  onRetry: () => void
}

export function isSubscribed(result: OrcaBillingStatusResult | null): boolean {
  return (
    result?.status === 'ok' &&
    result.entitlement.plan !== null &&
    result.entitlement.status !== 'canceled'
  )
}

function CurrentPlanStrip({
  entitlement
}: {
  entitlement: OrcaBillingEntitlement
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const resets = entitlement.usageWindow
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entitlement.usageWindow.end)
    : null
  const warning = usageWarningLine(entitlement, t, locale)
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{entitlement.planLabel}</span>
        <span className="text-muted-foreground">
          {t('auto.components.billing.plans.seatsPeriod', '{{value0}} · {{value1}}', {
            value0: seatCountLabel(entitlement.seats, t),
            value1:
              entitlement.interval === 'year'
                ? t('auto.components.billing.annual', 'Annual')
                : t('auto.components.billing.monthly', 'Monthly')
          })}
        </span>
        <PlanStatusBadge entitlement={entitlement} />
      </div>
      <Progress
        value={includedUsagePercent(entitlement)}
        tone={includedUsageTone(entitlement)}
        aria-label={t('auto.components.billing.sandboxHoursUsedLabel', 'Sandbox hours used')}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {t(
            'auto.components.billing.sandboxHoursUsedMonth',
            '{{value0}} of {{value1}} sandbox hours used this month',
            {
              value0: formatHoursUsed(
                Math.min(entitlement.usedSeconds, entitlement.includedSeconds)
              ),
              value1: formatHours(entitlement.includedSeconds)
            }
          )}
        </span>
        <span>
          {resets
            ? t(
                'auto.components.billing.plans.sandboxHoursLeftResets',
                '{{count}} sandbox hours left · resets {{date}}',
                {
                  count: sandboxHoursCount(entitlement.remainingIncludedSeconds),
                  date: resets,
                  defaultValue_one: '{{count}} sandbox hour left · resets {{date}}'
                }
              )
            : sandboxHoursLeftLine(entitlement, t)}
        </span>
      </div>
      {warning ? <p className="text-xs font-medium">{warning}</p> : null}
    </div>
  )
}

/** The interval to show: the one picked when it is on sale, else the first one that is. */
export function shownInterval(
  picked: OrcaBillingInterval,
  intervals: readonly OrcaBillingInterval[]
): OrcaBillingInterval {
  return intervals.includes(picked) ? picked : (intervals[0] ?? picked)
}

export function PlansView(props: PlansViewProps): React.JSX.Element {
  const t = useTranslate()
  const [picked, setInterval] = useState<OrcaBillingInterval>('month')
  const result = props.result
  const plans = resolvePlansModel(props.catalog, result)
  const ready = result?.status === 'ok' && plans.state === 'ready'
  // Once plans load (or after "Back to plans"), land on the dialog heading, never on a buy button
  // (Enter would start Checkout): Tab then reaches the interval toggle before the cards. Only when
  // focus is on the dialog or nowhere; never steal it from something the user picked.
  useEffect(() => {
    const active = document.activeElement
    if (
      ready &&
      (!active || active === document.body || active.getAttribute('role') === 'dialog')
    ) {
      document.querySelector<HTMLElement>('[role="dialog"] [data-plans-heading]')?.focus()
    }
  }, [ready])

  if (result?.status === 'signed-out' || result?.status === 'unconfigured') {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {result.status === 'signed-out'
          ? t(
              'auto.components.billing.openSignedOut2',
              'Sign in to Orca again to manage your team.'
            )
          : t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')}
      </p>
    )
  }
  if (result === null || (result.status === 'ok' && plans.state === 'loading')) {
    return <PlansSkeleton />
  }
  if (result.status !== 'ok' || plans.state !== 'ready') {
    // Never a guessed price: without billing's catalog (or offers) there is nothing to show.
    return <PlansLoadError onRetry={props.onRetry} />
  }

  const entitlement = result.entitlement
  const { team, enterprise } = plans.model
  const subscribed = isSubscribed(result)
  const mode: TeamPlanCardMode = subscribed
    ? 'current'
    : entitlement.canManageBilling
      ? 'choose'
      : 'locked'
  const paymentIssue = entitlement.payment.pastDueSince !== null
  const interval = shownInterval(picked, team.intervals)
  const seats = Math.max(team.seats.min, clampSeats(props.seats, team.seats.max))

  return (
    <div className="space-y-6">
      {subscribed ? (
        <>
          <PaymentIssueNotice
            entitlement={entitlement}
            busy={props.busy}
            onUpdatePayment={props.onManage}
          />
          <CurrentPlanStrip entitlement={entitlement} />
        </>
      ) : isOrcaCloudTrial(entitlement) ? (
        // The trial's strip: the plan cards right below are the way out of it (spec T1).
        <div className="rounded-xl border border-border bg-card p-4 shadow-xs">
          <TrialPlanSummary entitlement={entitlement} />
        </div>
      ) : (
        <ValueProps />
      )}
      {mode === 'choose' && team.intervals.length > 1 ? (
        <PlansIntervalToggle
          value={interval}
          savingsPercent={annualSavingsPercent(team)}
          disabled={props.busy}
          onChange={setInterval}
        />
      ) : null}
      <div className={enterprise ? 'grid items-stretch gap-4 md:grid-cols-2' : 'mx-auto max-w-md'}>
        <TeamPlanCard
          team={team}
          interval={subscribed && entitlement.interval ? entitlement.interval : interval}
          seats={seats}
          mode={mode}
          busy={props.busy}
          notice={props.notice}
          hideManage={paymentIssue}
          onCheckout={() => props.onCheckout({ planId: team.planId, interval, seats })}
          checkoutLink={
            props.checkoutLink
              ? () => props.checkoutLink!({ planId: team.planId, interval, seats })
              : undefined
          }
          onManage={props.onManage}
        />
        {enterprise ? (
          <EnterprisePlanCard enterprise={enterprise} onContactSales={props.onContactSales} />
        ) : null}
      </div>
      <div className="space-y-1 text-center text-xs text-muted-foreground text-pretty">
        <p>
          {t(
            'auto.components.billing.plans.footHours3',
            'Hours reset every month, including on annual plans.'
          )}
        </p>
        <p>
          {t(
            'auto.components.billing.plans.footTerms5',
            'Prices in {{currency}}, before tax. Overage is off until an owner or admin turns it on. Cancel anytime; your plan runs to the end of the billing period.',
            { currency: team.currency.toUpperCase() }
          )}
        </p>
      </div>
    </div>
  )
}
