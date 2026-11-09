import { useState } from 'react'
import { KeyRound, LaptopMinimal, RefreshCw, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  ORCA_BILLING_MAX_SEATS,
  type OrcaBillingEntitlement,
  type OrcaBillingInterval,
  type OrcaBillingStatusResult
} from '../../../../../shared/orca-billing'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { statusLabel } from '../plan-billing-copy'
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
      icon: LaptopMinimal,
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
      title: t('auto.components.billing.plans.vpSecretsTitle', 'Secrets never stored in the VM'),
      body: t(
        'auto.components.billing.plans.vpSecretsBody2',
        'Credentials are injected into outbound requests and never touch the VM’s disk.'
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
  const paymentIssue = entitlement.payment.pastDueSince !== null
  const resets = entitlement.usageWindow
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entitlement.usageWindow.end)
    : null
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{entitlement.planLabel}</span>
        <span className="text-muted-foreground">
          {t('auto.components.billing.plans.seatsAndPeriod', 'Seats: {{value0}} · {{value1}}', {
            value0: String(entitlement.seats),
            value1:
              entitlement.interval === 'year'
                ? t('auto.components.billing.annual', 'Annual')
                : t('auto.components.billing.monthly', 'Monthly')
          })}
        </span>
        {/* The payment banner carries the alarm; the badge stays quiet. */}
        <Badge variant={paymentIssue ? 'outline' : 'secondary'}>
          {statusLabel(entitlement.status, t)}
        </Badge>
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
              value0: formatHours(entitlement.usedSeconds),
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

function PlaceholderCards({
  failed,
  onRetry
}: {
  failed: boolean
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-6">
      <ValueProps />
      <div className="relative grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div aria-hidden className="h-[26rem] rounded-xl border border-border bg-muted/40" />
        <div aria-hidden className="h-[26rem] rounded-xl border border-border bg-muted/40" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {failed ? (
            <>
              <p>
                {t(
                  'auto.components.billing.plans.loadFailed',
                  'Could not load plans. Try again in a moment.'
                )}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw />
                {t('auto.components.billing.plans.retry', 'Try again')}
              </Button>
            </>
          ) : (
            <>
              <LoadingSpinner />
              <p>{t('auto.components.billing.plans.loading', 'Loading plans…')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function PlansView(props: PlansViewProps): React.JSX.Element {
  const t = useTranslate()
  const [interval, setInterval] = useState<OrcaBillingInterval>('month')
  const seats = clampSeats(props.seats, ORCA_BILLING_MAX_SEATS)
  const result = props.result

  if (result?.status === 'signed-out' || result?.status === 'unconfigured') {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {result.status === 'signed-out'
          ? t('auto.components.billing.openSignedOut', 'Sign in to Orca again to manage billing.')
          : t('auto.components.billing.openUnconfigured', 'Billing is unavailable in this build.')}
      </p>
    )
  }
  if (!result || result.status !== 'ok' || !result.entitlement.offers) {
    return <PlaceholderCards failed={result !== null} onRetry={props.onRetry} />
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
      <div className="grid items-stretch gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
            'auto.components.billing.plans.footHours',
            'Hours reset every month, including on annual plans. When they run out, new sandboxes wait until the next month unless overage is on.'
          )}
        </p>
        <p>
          {t(
            'auto.components.billing.plans.footTerms',
            'Prices in USD, before tax. Overage stays off until an owner or admin turns it on and sets a spend cap. Cancel anytime; your plan runs to the end of the period.'
          )}
        </p>
      </div>
    </div>
  )
}
