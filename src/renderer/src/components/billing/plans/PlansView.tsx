import { useEffect, useState } from 'react'
import { Cloud, KeyRound, Zap } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  ORCA_BILLING_MAX_SEATS,
  type OrcaBillingEntitlement,
  type OrcaBillingInterval,
  type OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { PlanStatusBadge } from '../PlanStatusBadge'
import { seatCountLabel } from '../team/team-copy'
import { formatHours, includedUsagePercent } from '../plan-billing-format'
import { EnterprisePlanCard } from './EnterprisePlanCard'
import { PlansIntervalToggle } from './PlansIntervalToggle'
import { TeamPlanCard, type TeamPlanCardMode } from './TeamPlanCard'
import { annualSavingsPercent, clampSeats } from './plans-pricing'

export type PlansViewProps = {
  result: OrcaBillingStatusResult | null
  busy: boolean
  notice: string | null
  /** Seats Checkout will bill: org members, or 1 for a personal account. */
  seats: number
  onCheckout: (args: { interval: OrcaBillingInterval; seats: number }) => void
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

function ValueProps(): React.JSX.Element {
  const t = useTranslate()
  // Same promises as the marketing site's /cloud page.
  const items = [
    {
      icon: Cloud,
      title: t('auto.components.billing.plans.vpRunningTitle', 'Agents keep running'),
      body: t(
        'auto.components.billing.plans.vpRunningBody2',
        'Sandboxes keep working while you are away and report back when they finish.'
      )
    },
    {
      icon: Zap,
      title: t('auto.components.billing.plans.vpWakeTitle', 'Wake in seconds'),
      body: t(
        'auto.components.billing.plans.vpWakeBody',
        'Idle sandboxes sleep to save hours and resume right where they left off.'
      )
    },
    {
      icon: KeyRound,
      title: t('auto.components.billing.plans.vpSecretsTitle3', 'API keys stay out of the sandbox'),
      body: t(
        'auto.components.billing.plans.vpSecretsBody4',
        'API keys you add to Orca are never written to the sandbox. Agents and terminals get them as environment variables.'
      )
    }
  ]
  return (
    <ul className="grid gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <li key={item.title} className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <item.icon className="size-4" />
          </span>
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{item.title}</p>
            <p className="text-xs leading-5 text-muted-foreground text-pretty">{item.body}</p>
          </div>
        </li>
      ))}
    </ul>
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
        aria-label={t('auto.components.billing.usageLabel', 'Included hours used')}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {t(
            'auto.components.billing.hoursUsedMonth',
            '{{value0}} of {{value1}} hours used this month',
            {
              value0: formatHours(Math.min(entitlement.usedSeconds, entitlement.includedSeconds)),
              value1: formatHours(entitlement.includedSeconds)
            }
          )}
        </span>
        <span>
          {resets
            ? t(
                'auto.components.billing.plans.leftResets',
                '{{value0}} hours left · resets {{value1}}',
                {
                  value0: formatHours(entitlement.remainingIncludedSeconds),
                  value1: resets
                }
              )
            : null}
        </span>
      </div>
    </div>
  )
}

function SkeletonLine({ className }: { className: string }): React.JSX.Element {
  return <Skeleton className={className} />
}

function SkeletonCard({ lines }: { lines: number }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col gap-5 rounded-xl border border-border bg-card p-5 shadow-xs">
      <SkeletonLine className="h-4 w-24" />
      <div className="space-y-2">
        <SkeletonLine className="h-8 w-32" />
        <SkeletonLine className="h-3 w-28" />
      </div>
      <div className="flex-1 space-y-3">
        {Array.from({ length: lines }, (_, index) => (
          <SkeletonLine key={index} className={index % 2 ? 'h-3 w-4/5' : 'h-3 w-11/12'} />
        ))}
      </div>
      <div className="min-h-[6rem] space-y-2 border-t border-border/60 pt-4">
        <SkeletonLine className="h-9 w-full" />
        <SkeletonLine className="mx-auto h-3 w-3/5" />
      </div>
    </div>
  )
}

/** Same geometry as the loaded page (value props, toggle, two cards) so nothing jumps (review M4). */
function PlansSkeleton(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="space-y-6"
      role="status"
      aria-label={t('auto.components.billing.plans.loading', 'Loading plans…')}
    >
      <ValueProps />
      <div className="flex justify-center">
        <Skeleton shape="circle" className="h-8 w-72" />
      </div>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <SkeletonCard lines={5} />
        <SkeletonCard lines={4} />
      </div>
      <div className="mx-auto max-w-xl space-y-1.5">
        <Skeleton className="mx-auto h-3 w-2/3" />
        <Skeleton className="mx-auto h-3 w-5/6" />
      </div>
    </div>
  )
}

function PlansLoadError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-6">
      <ValueProps />
      <InlineError
        className="mx-auto my-16 max-w-md"
        title={t('auto.components.billing.plans.loadFailedTitle', 'Plans didn’t load')}
        detail={t(
          'auto.components.billing.plans.loadFailed',
          'Could not load plans. Try again in a moment.'
        )}
        retryLabel={t('auto.components.billing.plans.retry', 'Try again')}
        onRetry={onRetry}
      />
    </div>
  )
}

export function PlansView(props: PlansViewProps): React.JSX.Element {
  const t = useTranslate()
  const [interval, setInterval] = useState<OrcaBillingInterval>('month')
  const seats = clampSeats(props.seats, ORCA_BILLING_MAX_SEATS)
  const result = props.result
  const ready = result?.status === 'ok'
  // Once plans load (or after "Back to plans"), land on this state's primary action, but only if
  // focus is still on the dialog or nowhere; never steal it from something the user picked.
  useEffect(() => {
    const active = document.activeElement
    if (
      ready &&
      (!active || active === document.body || active.getAttribute('role') === 'dialog')
    ) {
      document.querySelector<HTMLElement>('[role="dialog"] [data-plans-primary]')?.focus()
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
  if (!result || result.status !== 'ok' || !result.entitlement.offers) {
    return result === null ? <PlansSkeleton /> : <PlansLoadError onRetry={props.onRetry} />
  }

  const entitlement = result.entitlement
  const offers = result.entitlement.offers
  const subscribed = isSubscribed(result)
  const mode: TeamPlanCardMode = subscribed
    ? 'current'
    : entitlement.canManageBilling
      ? 'choose'
      : 'locked'
  const paymentIssue = entitlement.payment.pastDueSince !== null

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
      ) : (
        <ValueProps />
      )}
      {mode === 'choose' ? (
        <PlansIntervalToggle
          value={interval}
          savingsPercent={annualSavingsPercent(offers.team)}
          disabled={props.busy}
          onChange={setInterval}
        />
      ) : null}
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <TeamPlanCard
          team={offers.team}
          interval={subscribed && entitlement.interval ? entitlement.interval : interval}
          seats={seats}
          mode={mode}
          busy={props.busy}
          notice={props.notice}
          hideManage={paymentIssue}
          onCheckout={() => props.onCheckout({ interval, seats })}
          onManage={props.onManage}
        />
        <EnterprisePlanCard
          enterprise={offers.enterprise}
          onContactSales={() => props.onContactSales(offers.enterprise.contactUrl)}
        />
      </div>
      <div className="space-y-1 text-center text-xs text-muted-foreground text-pretty">
        <p>
          {t(
            'auto.components.billing.plans.footHours2',
            'Hours reset monthly, including on annual plans.'
          )}
        </p>
        <p>
          {t(
            'auto.components.billing.plans.footTerms4',
            'Prices in USD, before tax. Overage is off until an owner or admin turns it on. Cancel anytime; your plan runs to the end of the billing period.'
          )}
        </p>
      </div>
    </div>
  )
}
