import { useEffect, useId, useRef } from 'react'
import { AlertCircle, Check, ExternalLink, Lock, RotateCcw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { OrcaBillingOffers } from '../../../../../shared/orca-billing'
import { openFailureCopy } from '../plan-billing-copy'
import { formatCents, periodTotalCents } from '../plans/plans-pricing'
import type { CheckoutPhase } from './checkout-flow'
import { seatCountLabel } from '../team/team-copy'

export type CheckoutPanelProps = {
  phase: Exclude<CheckoutPhase, { kind: 'idle' }>
  team: OrcaBillingOffers['team']
  /** When the order was placed; the renewal date counts from it. */
  now: number
  onReopen: () => void
  onKeepWaiting: () => void
  onBack: () => void
}

function OrderSummary({
  phase,
  team,
  now
}: Pick<CheckoutPanelProps, 'phase' | 'team'> & { now: number }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { interval, seats } = phase.order
  const perSeat = interval === 'year' ? team.annualPriceCentsPerSeat : team.monthlyPriceCentsPerSeat
  const total = periodTotalCents(team, interval, seats)
  const renews = new Date(now)
  if (interval === 'year') {
    renews.setFullYear(renews.getFullYear() + 1)
  } else {
    renews.setMonth(renews.getMonth() + 1)
  }
  const renewsLabel = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(renews)
  return (
    <dl className="space-y-2 rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="font-medium">
          {interval === 'year'
            ? t('auto.components.billing.checkout.planAnnual', '{{value0}} · Annual', {
                value0: team.label
              })
            : t('auto.components.billing.checkout.planMonthly', '{{value0}} · Monthly', {
                value0: team.label
              })}
        </dt>
        <dd className="text-muted-foreground tabular-nums">
          {perSeat === null
            ? null
            : t(
                'auto.components.billing.checkout.seatsTimes2',
                '{{value0}} × {{value1}}{{value2}}',
                {
                  value0: seatCountLabel(seats, t),
                  value1: formatCents(perSeat, locale),
                  value2:
                    interval === 'year'
                      ? t('auto.components.billing.checkout.perYr', '/yr')
                      : t('auto.components.billing.checkout.perMo', '/mo')
                }
              )}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3 border-t border-border/60 pt-2">
        <dt className="font-medium">
          {phase.kind === 'paid'
            ? t('auto.components.billing.checkout.paidRow', 'Paid')
            : t('auto.components.billing.checkout.dueToday', 'Due today')}
        </dt>
        <dd className="text-base font-semibold tabular-nums">
          {total === null ? '—' : formatCents(total, locale)}
        </dd>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.billing.checkout.renewsNote',
          'Renews {{value0}}. Before tax. Seats follow your team.',
          { value0: renewsLabel }
        )}
      </p>
    </dl>
  )
}

function StatusIcon({ phase }: { phase: CheckoutPanelProps['phase'] }): React.JSX.Element {
  if (phase.kind === 'paid') {
    return (
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full border border-status-success-border bg-status-success-background text-status-success animate-in zoom-in-50 fade-in-0 duration-300 motion-reduce:animate-none"
      >
        <Check className="size-6" strokeWidth={2.5} />
      </span>
    )
  }
  if (phase.kind === 'canceled' || phase.kind === 'open-failed') {
    return (
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <XCircle className="size-5" />
      </span>
    )
  }
  if (phase.kind === 'needs-attention' || phase.kind === 'timed-out') {
    return (
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full border border-status-warning-border bg-status-warning-background text-status-warning-text"
      >
        <AlertCircle className="size-5" />
      </span>
    )
  }
  return (
    <span aria-hidden className="relative flex size-11 items-center justify-center">
      <span className="absolute inset-0 rounded-full bg-foreground/5 motion-safe:animate-pulse" />
      <LoadingSpinner />
    </span>
  )
}

/**
 * What the plans dialog shows while Checkout runs in the browser: the order, what is happening,
 * and the next step. Announced politely so screen readers hear each change.
 */
export function CheckoutPanel(props: CheckoutPanelProps): React.JSX.Element {
  const t = useTranslate()
  const { phase } = props
  const now = props.now
  const headingRef = useRef<HTMLHeadingElement>(null)
  const bodyId = useId()

  // Move focus with the state so keyboard users land on the new message and its actions.
  useEffect(() => {
    headingRef.current?.focus()
  }, [phase.kind])

  let title: string
  let body: string
  switch (phase.kind) {
    case 'opening':
      title = t('auto.components.billing.checkout.opening', 'Opening secure checkout…')
      body = t(
        'auto.components.billing.checkout.openingBody',
        'Stripe’s checkout opens in your browser.'
      )
      break
    case 'awaiting-payment':
      title = t('auto.components.billing.checkout.finish', 'Finish payment in your browser')
      body = t(
        'auto.components.billing.checkout.finishBody',
        'This updates the moment Stripe confirms. Your card details go to Stripe, never to Orca.'
      )
      break
    case 'paid':
      title = t('auto.components.billing.checkout.paid', 'Payment confirmed')
      body = t(
        'auto.components.billing.checkout.paidBody',
        'You’re on {{value0}}. Opening your team…',
        { value0: props.team.label }
      )
      break
    case 'canceled':
      title = t('auto.components.billing.checkout.canceled', 'Checkout canceled')
      body = t(
        'auto.components.billing.checkout.canceledBody',
        'Nothing was charged. You can pick up where you left off any time.'
      )
      break
    case 'needs-attention':
      title = t('auto.components.billing.checkout.attention2', 'Stripe needs one more step')
      body = t(
        'auto.components.billing.checkout.attentionBody',
        'Your bank asked for verification or declined the card. Reopen checkout to finish, or use another card.'
      )
      break
    case 'timed-out':
      title = t('auto.components.billing.checkout.timedOut', 'Still waiting for Stripe')
      body = t(
        'auto.components.billing.checkout.timedOutBody',
        'If you already paid, confirmation can take a minute. Otherwise reopen checkout.'
      )
      break
    case 'open-failed':
      title = t('auto.components.billing.checkout.openFailed', 'Checkout didn’t open')
      body =
        openFailureCopy(phase.result, t) ??
        t('auto.components.billing.openFailed', 'Could not reach billing. Try again.')
      break
  }

  const reopen = (
    <Button type="button" onClick={props.onReopen}>
      {phase.kind === 'canceled' || phase.kind === 'open-failed' ? <RotateCcw /> : null}
      {phase.kind === 'canceled' || phase.kind === 'open-failed'
        ? t('auto.components.billing.checkout.tryAgain', 'Try again')
        : t('auto.components.billing.checkout.reopen', 'Reopen checkout')}
      {phase.kind === 'canceled' || phase.kind === 'open-failed' ? null : <ExternalLink />}
    </Button>
  )
  const back = (
    <Button type="button" variant="ghost" onClick={props.onBack}>
      {phase.kind === 'awaiting-payment' || phase.kind === 'opening'
        ? t('auto.components.billing.checkout.cancel', 'Cancel')
        : t('auto.components.billing.checkout.back', 'Back to plans')}
    </Button>
  )

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-2">
      {/* Focus moves to the heading on each change (described by the body), which screen
          readers announce once; no separate live region, so nothing is read twice. */}
      <div className="flex flex-col items-center gap-3 text-center">
        <StatusIcon phase={phase} />
        <h3
          ref={headingRef}
          tabIndex={-1}
          aria-describedby={bodyId}
          className="text-lg font-semibold tracking-tight outline-none"
        >
          {title}
        </h3>
        <p
          id={bodyId}
          className={cn(
            'max-w-sm text-sm text-pretty',
            phase.kind === 'open-failed' ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {body}
        </p>
      </div>

      <OrderSummary phase={phase} team={props.team} now={now} />

      {phase.kind === 'paid' ? null : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {phase.kind === 'opening' ? null : reopen}
          {phase.kind === 'timed-out' ? (
            <Button type="button" variant="outline" onClick={props.onKeepWaiting}>
              {t('auto.components.billing.checkout.keepWaiting', 'Keep waiting')}
            </Button>
          ) : null}
          {back}
        </div>
      )}

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3" />
        {t(
          'auto.components.billing.checkout.secured2',
          'Payments by Stripe · Cards, Apple Pay and Link · Bank verification'
        )}
      </p>
    </div>
  )
}
