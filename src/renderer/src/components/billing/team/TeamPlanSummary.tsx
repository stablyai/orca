import { useEffect, useRef } from 'react'
import { ArrowRight, Check, Cloud, ExternalLink, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../../shared/orca-billing'
import { PaymentIssueNotice } from '../PaymentIssueNotice'
import { PlanStatusBadge } from '../PlanStatusBadge'
import { formatCents, perSeatMonthlyCents } from '../plans/plans-pricing'
import { seatCountLabel } from './team-copy'
import { isActivePlan, nextInvoiceEstimate } from './team-seat-math'

/** One-time confirmation after Checkout: tasteful, dismissible, with the obvious next steps. */
export function TeamCheckoutCelebration({
  seats,
  planLabel,
  onCreateWorkspace,
  onInvite,
  onDismiss
}: {
  seats: number
  planLabel: string
  onCreateWorkspace: () => void
  onInvite: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  return (
    <section
      aria-labelledby="team-celebration-title"
      className="relative overflow-hidden rounded-xl border border-status-success-border bg-status-success-background p-4 animate-in fade-in-0 slide-in-from-top-2 duration-300 motion-reduce:animate-none"
    >
      {/* Soft glow; static, so reduced motion loses nothing. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-status-success/20 blur-3xl"
      />
      <div className="relative flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-status-success text-background shadow-sm animate-in zoom-in-50 duration-300 motion-reduce:animate-none"
        >
          <Check className="size-5" strokeWidth={2.5} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h3
            id="team-celebration-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold tracking-tight outline-none"
          >
            {t('auto.components.billing.team.celebrateTitle', 'You’re on {{value0}}', {
              value0: planLabel
            })}
          </h3>
          <p className="text-sm text-muted-foreground text-pretty">
            {t(
              'auto.components.billing.team.celebrateBody',
              '{{value0}} active. Orca Cloud is ready: agents keep running in the cloud when you step away.',
              { value0: seatCountLabel(seats, t) }
            )}
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button type="button" size="sm" onClick={onCreateWorkspace}>
              <Cloud />
              {t('auto.components.billing.team.createWorkspace', 'Create a cloud workspace')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onInvite}>
              <UserPlus />
              {t('auto.components.billing.team.inviteTeammates', 'Invite teammates')}
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t('auto.components.billing.team.dismiss', 'Dismiss')}
        >
          <X />
        </Button>
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  detail
}: {
  label: string
  value: string
  detail?: string | null
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
      {detail ? <dd className="truncate text-xs text-muted-foreground">{detail}</dd> : null}
    </div>
  )
}

/** Seats in use vs paid, the plan, and the next invoice (an estimate before tax and overage). */
export function TeamSeatsCard({
  entitlement,
  members,
  busy,
  onManageBilling,
  onSeePlans
}: {
  entitlement: OrcaBillingEntitlement
  members: number
  busy: boolean
  onManageBilling: () => void
  onSeePlans: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const date = (ms: number): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ms)
  const invoice = nextInvoiceEstimate(entitlement)
  const seatsDetail = entitlement.seatChange
    ? t('auto.components.billing.team.seatsDropOn', 'Drops to {{value0}} on {{value1}}', {
        value0: String(entitlement.seatChange.seatsAtRenewal),
        value1: date(entitlement.seatChange.effectiveAt)
      })
    : t('auto.components.billing.team.seatsInUse', '{{value0}} in use', {
        value0: String(Math.min(members, entitlement.seats))
      })
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{entitlement.planLabel}</p>
        <PlanStatusBadge entitlement={entitlement} />
        <span className="flex-1" />
        {entitlement.canManageBilling ? (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={onSeePlans}>
              {t('auto.components.billing.team.usage', 'Usage & plan')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onManageBilling}
            >
              {t('auto.components.billing.manageBilling', 'Manage billing')}
              <ExternalLink />
            </Button>
          </>
        ) : null}
      </div>
      <dl className="grid grid-cols-3 gap-4">
        <Stat
          label={t('auto.components.billing.team.seatsPaid', 'Seats paid')}
          value={String(entitlement.seats)}
          detail={seatsDetail}
        />
        <Stat
          label={t('auto.components.billing.team.billing', 'Billing')}
          value={
            entitlement.interval === 'year'
              ? t('auto.components.billing.annual', 'Annual')
              : t('auto.components.billing.monthly', 'Monthly')
          }
          detail={
            entitlement.offers
              ? t('auto.components.billing.team.perSeatMo', '{{value0}} per seat / month', {
                  value0: formatCents(
                    perSeatMonthlyCents(entitlement.offers.team, entitlement.interval ?? 'month') ??
                      0,
                    locale
                  )
                })
              : null
          }
        />
        {invoice ? (
          <Stat
            label={t('auto.components.billing.team.nextInvoice', 'Next invoice (est.)')}
            value={formatCents(invoice.amountCents, locale)}
            detail={t('auto.components.billing.team.nextInvoiceOn', '{{value0}} · {{value1}}', {
              value0: date(invoice.at),
              value1: seatCountLabel(invoice.seats, t)
            })}
          />
        ) : (
          <Stat
            label={t('auto.components.billing.team.planEnds', 'Plan ends')}
            value={entitlement.period ? date(entitlement.period.end) : '—'}
          />
        )}
      </dl>
      <p className="text-xs text-muted-foreground text-pretty">
        {t(
          'auto.components.billing.team.seatRules',
          'New members above your paid seats are charged now, prorated. Removed seats stay paid until renewal, and re-adding someone this period is free.'
        )}
      </p>
    </div>
  )
}

/** "Upgrade to use Orca Cloud" for teams without a plan. Members see who can upgrade. */
export function TeamUpgradeCard({
  entitlement,
  onSeePlans
}: {
  entitlement: OrcaBillingEntitlement
  onSeePlans: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const monthly = entitlement.offers?.team.monthlyPriceCentsPerSeat ?? null
  return (
    <section
      aria-labelledby="team-upgrade-title"
      className="relative overflow-hidden rounded-xl border border-border bg-card p-4 shadow-xs"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_100%_0%,color-mix(in_oklab,var(--foreground)_7%,transparent),transparent_60%)]"
      />
      <div className="relative flex flex-wrap items-center gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <Cloud className="size-4" />
        </span>
        <div className="min-w-[14rem] flex-1 space-y-0.5">
          <h3 id="team-upgrade-title" className="text-sm font-semibold">
            {t('auto.components.billing.upgrade.title', 'Upgrade to use Orca Cloud')}
          </h3>
          <p className="text-xs text-muted-foreground text-pretty">
            {monthly === null
              ? t(
                  'auto.components.billing.upgrade.bodyNoPrice',
                  'Hosted sandboxes for the whole team. Agents keep running when you close your laptop.'
                )
              : t(
                  'auto.components.billing.upgrade.body',
                  'Hosted sandboxes for the whole team. Agents keep running when you close your laptop. {{value0}} per seat / month.',
                  { value0: formatCents(monthly, locale) }
                )}
          </p>
        </div>
        {entitlement.canManageBilling ? (
          <Button type="button" onClick={onSeePlans}>
            {t('auto.components.billing.upgrade.cta', 'See plans')}
            <ArrowRight />
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('auto.components.billing.upgrade.askOwner', 'Ask an owner or admin to upgrade.')}
          </p>
        )}
      </div>
    </section>
  )
}

export function TeamBillingBlock({
  entitlement,
  members,
  busy,
  onManageBilling,
  onSeePlans
}: {
  entitlement: OrcaBillingEntitlement
  members: number
  busy: boolean
  onManageBilling: () => void
  onSeePlans: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <PaymentIssueNotice entitlement={entitlement} busy={busy} onUpdatePayment={onManageBilling} />
      {isActivePlan(entitlement) ? (
        <TeamSeatsCard
          entitlement={entitlement}
          members={members}
          busy={busy}
          onManageBilling={onManageBilling}
          onSeePlans={onSeePlans}
        />
      ) : (
        <TeamUpgradeCard entitlement={entitlement} onSeePlans={onSeePlans} />
      )}
    </div>
  )
}
