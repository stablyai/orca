import { ExternalLink, Lock, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingInterval, OrcaBillingOffers } from '../../../../../shared/orca-billing'
import { PlanCardShell } from './PlanCardShell'
import { formatCents, perSeatMonthlyCents, periodTotalCents } from './plans-pricing'

export type TeamPlanCardMode = 'choose' | 'current' | 'locked'

export function TeamPlanCard({
  team,
  interval,
  seats,
  mode,
  busy,
  notice,
  hideManage,
  onCheckout,
  onManage
}: {
  team: OrcaBillingOffers['team']
  interval: OrcaBillingInterval
  seats: number
  /** choose: can buy; current: already on Team; locked: only owners/admins can buy. */
  mode: TeamPlanCardMode
  busy: boolean
  notice: string | null
  /** A payment banner already offers the same Portal action. */
  hideManage: boolean
  onCheckout: () => void
  onManage: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const monthly = perSeatMonthlyCents(team, interval)
  const fullMonthly = team.monthlyPriceCentsPerSeat
  const total = periodTotalCents(team, interval, seats)
  const discounted =
    interval === 'year' && monthly !== null && fullMonthly !== null && monthly < fullMonthly

  const features = [
    t(
      'auto.components.billing.plans.featureHours2',
      '{{value0}} Standard hours (4 vCPU / 8 GB) per seat each month, pooled across your team',
      { value0: String(team.includedHoursPerSeat) }
    ),
    t(
      'auto.components.billing.plans.featureLarge2',
      'Large (8 vCPU / 16 GB) uses hours at {{value0}}×',
      {
        value0: String(team.largeMachineWeight)
      }
    ),
    t('auto.components.billing.plans.featureConcurrency', '{{value0}} running sandboxes per seat', {
      value0: String(team.concurrentSandboxesPerSeat)
    }),
    t('auto.components.billing.plans.featureSleep2', 'Sleeps after {{value0}} minutes idle', {
      value0: String(team.idleSleepMinutes)
    }),
    t(
      'auto.components.billing.plans.featureOverage',
      'Optional overage at {{value0}}/hr ({{value1}}/hr Large) with a monthly spend cap',
      {
        value0: formatCents(team.overageCentsPerHour, locale),
        value1: formatCents(team.overageCentsPerHour * team.largeMachineWeight, locale)
      }
    )
  ]

  const price = (
    // Keyed so the figure fades in again when the period changes.
    <p
      key={interval}
      className="flex items-baseline gap-1.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none"
    >
      {discounted && fullMonthly !== null ? (
        <del className="text-lg text-muted-foreground tabular-nums">
          <span className="sr-only">{t('auto.components.billing.plans.was', 'Was')} </span>
          {formatCents(fullMonthly, locale)}
        </del>
      ) : null}
      <span className="text-3xl font-semibold tracking-tight tabular-nums">
        {monthly === null
          ? interval === 'month'
            ? team.monthlyPriceLabel
            : team.annualPriceLabel
          : formatCents(monthly, locale)}
      </span>
      {monthly === null ? null : (
        <span className="text-sm text-muted-foreground">
          {t('auto.components.billing.plans.perSeatMonth', 'per seat / month')}
        </span>
      )}
    </p>
  )

  const priceNote =
    interval === 'year'
      ? team.annualPriceCentsPerSeat === null
        ? t('auto.components.billing.plans.billedYearly', 'Billed yearly')
        : t(
            'auto.components.billing.plans.billedYearlyAmount',
            'Billed {{value0}} per seat yearly',
            {
              value0: formatCents(team.annualPriceCentsPerSeat, locale)
            }
          )
      : t('auto.components.billing.plans.billedMonthly', 'Billed monthly')

  const details =
    mode === 'choose' ? (
      <div className="flex items-baseline justify-between gap-3 rounded-md bg-muted/60 px-3 py-2">
        <p className="text-xs text-muted-foreground">
          {t('auto.components.billing.plans.seatsOne', 'Seats: {{value0}} (one per team member)', {
            value0: String(seats)
          })}
        </p>
        {total === null ? null : (
          <p className="text-sm font-medium tabular-nums" aria-live="polite">
            {interval === 'year'
              ? t('auto.components.billing.plans.totalYear', '{{value0}} / year', {
                  value0: formatCents(total, locale)
                })
              : t('auto.components.billing.plans.totalMonth', '{{value0}} / month', {
                  value0: formatCents(total, locale)
                })}
          </p>
        )}
      </div>
    ) : null

  let footer: React.ReactNode
  if (mode === 'choose') {
    footer = (
      <>
        <Button
          type="button"
          className="w-full"
          disabled={busy}
          onClick={onCheckout}
          data-plans-primary=""
        >
          {busy ? <LoadingSpinner /> : null}
          {busy
            ? t('auto.components.billing.plans.waiting', 'Waiting for checkout…')
            : t('auto.components.billing.plans.checkout', 'Continue to checkout')}
          {busy ? null : <ExternalLink />}
        </Button>
        <p role="status" className="text-center text-xs text-muted-foreground text-pretty">
          {notice ??
            t(
              'auto.components.billing.plans.seatsFollow2',
              'Seats follow your team: new members add a seat now; removed seats drop off at renewal.'
            )}
        </p>
      </>
    )
  } else if (mode === 'current') {
    footer = hideManage ? (
      <p className="text-center text-xs text-muted-foreground">
        {t(
          'auto.components.billing.plans.fixPaymentAbove',
          'Update your payment method above to keep your plan active.'
        )}
      </p>
    ) : (
      <>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={onManage}
          data-plans-primary=""
        >
          {t('auto.components.billing.manageBilling', 'Manage billing')}
          <ExternalLink />
        </Button>
        <p role="status" className="text-center text-xs text-muted-foreground">
          {notice ??
            t(
              'auto.components.billing.plans.manageHint',
              'Switch monthly or annual, update payment, or cancel.'
            )}
        </p>
      </>
    )
  } else {
    footer = (
      <div className="flex items-start gap-2 text-sm">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-pretty">
          {t(
            'auto.components.billing.plans.lockedBody',
            'Only an owner or admin of your org can choose a plan. Ask one of them to open Plan & billing in Orca.'
          )}
        </p>
      </div>
    )
  }

  return (
    <PlanCardShell
      id="plans-team-title"
      title={
        <>
          <Users className="size-4 text-muted-foreground" />
          {team.label}
        </>
      }
      badge={
        mode === 'current' ? (
          <Badge variant="secondary">
            {t('auto.components.billing.plans.currentPlan', 'Current plan')}
          </Badge>
        ) : null
      }
      price={price}
      priceNote={priceNote}
      details={details}
      features={features}
      footer={footer}
    />
  )
}
